#!/usr/bin/env node
/*
 * check-diagnostics.js — build-time gate for the Missing-Data Diagnostic
 * (session 093, Phase 1).
 *
 * Runs BEFORE webpack, alongside `check-intent-map.js`, so a drift or a
 * regression fails the build in a couple of seconds rather than shipping a
 * diagnostic that misinforms a customer.
 *
 * What is checked:
 *
 *  1. `utils/splProbe.consistency-test.ts`     — the SPL classifier + lint rules
 *  2. `utils/panelDiagnosis.consistency-test.ts` — the verdict cascade, including
 *     the invariant that no free check may assert a system fault without
 *     dispatched evidence.
 *  2a. `utils/diagCascade.consistency-test.ts` — the dispatched-verdict gates.
 *  2b. LIVE aggregate-scope trace against the shipped savedsearches.conf.
 *  3. LIVE DRIFT CHECK — `EVAL_STRING_BOOLEAN_FIELDS` in `splProbe.ts` must
 *     exactly equal the set of `EVAL-<field>` directives in the shipped
 *     `default/props.conf` that yield a quoted "true"/"false".
 *  3b. LIVE DRIFT CHECK (build 311) — the `logserv_diag_reports` conf trio +
 *     the pinned retention SPL, derived from `utils/diagPersistence.ts`.
 *  3c. SOURCE PIN (build 312) — the Diagnostics page's completion path must
 *     read `runner.isCancelled()` BEFORE `endDiagnosis()` releases (and
 *     thereby cancels) the runner. The .ts-only suites cannot render the
 *     component, so this ordering is pinned at the source level.
 *  4. Async tests: `diagEvidence` / `diagReport` / `diagPersistence`
 *     consistency tests (fake-runner / fake-fetch driven; export `run()`).
 *
 * The live drift checks are why this script exists rather than just running
 * the tests. The lint rule that catches `icm_is_error=1`
 * depends on knowing which fields are string booleans. If someone adds an
 * `EVAL-is_something = if(..., "true", "false")` to props.conf and the table is
 * not updated, the diagnostic silently stops catching that defect class; if a
 * field is REMOVED from props.conf and left in the table, the diagnostic starts
 * accusing correct SPL. Deriving the expectation from props.conf at build time
 * makes both impossible (design doc, Risk 9 — stale-doc poisoning of the rule
 * set).
 *
 * No new dependency: TypeScript is already a devDependency and is used here to
 * transpile in memory. Deliberately does NOT use ts-node (not in the lockfile).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// Resolve TypeScript by explicit relative path rather than require.resolve():
// with sibling version snapshots on disk, Node's upward node_modules walk has
// been observed resolving into a DIFFERENT snapshot's tree (session-091 sticky).
const TS_PATH = path.resolve(__dirname, '../../../node_modules/typescript');
let ts;
try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    ts = require(TS_PATH);
} catch (e) {
    console.error(`check-diagnostics: cannot load TypeScript from ${TS_PATH}`);
    console.error('  (expected the workspace-root node_modules — run `yarn install --ignore-engines`)');
    process.exit(1);
}

const UTILS = path.resolve(__dirname, '../src/main/webapp/pages/home/utils');
const PROPS_CONF = path.resolve(
    __dirname,
    '../src/main/resources/splunk/default/props.conf',
);

// --- 1 & 2: run the two consistency tests ---------------------------------

/**
 * Transpile + evaluate a TS module in-process, resolving its relative imports
 * to sibling TS files transpiled the same way. Small, purpose-built loader —
 * the dependency graph here is three files deep and entirely local.
 */
const cache = new Map();
const loadTs = (absNoExt) => {
    if (cache.has(absNoExt)) return cache.get(absNoExt).exports;
    const src = fs.readFileSync(`${absNoExt}.ts`, 'utf8');
    const js = ts.transpileModule(src, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2017,
        },
        fileName: `${absNoExt}.ts`,
    }).outputText;

    const m = new Module(absNoExt, null);
    m.filename = `${absNoExt}.ts`;
    m.paths = Module._nodeModulePaths(path.dirname(absNoExt));
    cache.set(absNoExt, m);

    const wrapped = Module.wrap(js);
    // eslint-disable-next-line no-eval
    const fn = eval(wrapped);
    const localRequire = (spec) => {
        if (spec.startsWith('.')) {
            return loadTs(path.resolve(path.dirname(absNoExt), spec));
        }
        // eslint-disable-next-line import/no-dynamic-require, global-require
        return require(spec);
    };
    fn.call(m.exports, m.exports, localRequire, m, m.filename, path.dirname(absNoExt));
    m.loaded = true;
    return m.exports;
};

const TESTS = [
    'splProbe.consistency-test',
    'panelDiagnosis.consistency-test',
    'diagCascade.consistency-test',
    // §14.6 (build 313) — the title extractor feeding the drawer header and
    // the panel report's scope line lives in a gate-safe .ts precisely so it
    // can be tested here.
    'reactText.consistency-test',
    // §17.1 (Phase 5) — the raw-twin channel feeding check 21.
    'rawTwin.consistency-test',
    // §18 (Phase 6) — the column-coverage channel + the partial-mode
    // invariants (emptiness-verdict sweep, zero-resolution, the honest floor).
    'columnCoverage.consistency-test',
    // Build 321 (session 107) - the topology edge identity contract: what
    // useTopologyData CARRIES onto an edge vs what the SPL builders ACCEPT.
    'topologyEdgeIds.consistency-test',
    // Build 322 (session 108) - the node panel's derived facts: ownership
    // classification, the traffic rows' 100%-of-calls property, the partner
    // split's treatment of bidirectional edges, and donut geometry.
    'panelFacts.consistency-test',
    // Build 329 (session 112) - the IP enrichment merge + ambiguity guards
    // (per-IP hostname uniqueness after normalization, the crowd guard, the
    // user-line rule, sanitize-on-read). The conf side is section 3r.
    'topologyEnrichment.consistency-test',
    // Session 131 - the custom backfill window: UTC resolution under a frozen
    // clock, the retention floor, and the CHUNK COVER (contiguous, ordered,
    // day-aligned, exactly covering the window). The cover is what makes
    // chunking safe: an overlap double-aggregates an hourly bucket, a gap
    // leaves an hour unbuilt, and a boundary inside a day would split the
    // day-scoped beaconing streamstats.
    'backfillWindow.consistency-test',
    // Session 132 - the chart colour maps: every status word's case variants
    // agree (HANA Audit's upper-case HIGH/MEDIUM/LOW had matched nothing), words
    // that share a chart never share a colour (Windows drew critical and high in
    // one red), and the build-352 count-aware fallback only fires past the ramp.
    'chartPalettes.consistency-test',
    // Session 134 - the backfill wait policy: no poll-count ceiling (build 353
    // reported a still-running search FAILED after ~90 minutes), only Splunk's
    // own verdicts fail an arm, and anything else that ends the wait is
    // DETACHED ("still running on the server"). Mutation-tested 28/28.
    'backfillPoll.consistency-test',
    // Session 147 - the late-arriving data check: its window (the later of 30
    // days back and the reference rollup's oldest bucket, to three hours before
    // the current hour), the row parser, and the day ranges the one-click
    // rebuild dispatches - exactly the listed days, nothing else.
    'lateArrivals.consistency-test',
    // Session 149 (build 376) - the AI Assistant's saved-search allow-list:
    // only the intent map's saved searches can be sent (none of them writes),
    // the MCP arguments are built key by key, only the two declared tools
    // pass, and splGuard refuses every way of rerunning a saved search from
    // an ad-hoc query. Mutation-tested 54/54. The wiring and conf side is 3z.
    'savedSearchAllowList.consistency-test',
    // Session 149 (build 376, round 4) - what a failed tool call tells the AI
    // vendor: an HTTP status (an integer 100..599, or nothing) and one of a
    // fixed set of error classes, never the Splunk or MCP error text; the
    // App's own refusals pass their App-written reason. Mutation-tested 34/34.
    // The hook side is 3z (f).
    'vendorErrorText.consistency-test',
    // Session 149 (build 376, rounds 5 to 8) - what a Tier 2 summary tells the
    // AI vendor about columns: a column name only when Splunk generates it or
    // every word of it is author text (the model's own query, or the catalog
    // SPL of the saved search that ran; a display alias quoted after AS, at
    // most 40 characters), any other name as col_N; values fail closed - sent
    // in clear only when the column is traced, through constructs the reader
    // fully understands, to fields that are not identifiers, else hashed
    // (numeric statistics withheld for identifiers and mixed columns); the
    // _time range only when every value is a timestamp. Mutation-tested 88/88.
    // The hook side is 3z (f) 'tier2Summary columns', 'authorTexts statement',
    // 'catalog SPL bindings' and 'Tier 2 primer'; the value rule's side is 3z
    // (f) 'value caps', 'value rule', 'values fail closed', 'identifier
    // values' and 'traced values sent'.
    'vendorColumnText.consistency-test',
    // Build 377 (AI-a2-names, option B) - every field name the App defines
    // (props / transforms / collections / lookups) has a class in
    // utils/fieldClassification.ts, none weaker than the name patterns; a new
    // extraction cannot ship unclassified.
    'fieldClassification.consistency-test',
    // Build 377 (AI-b) - every statically listed model id is priced, the
    // Claude 5.x ids at the published first-party rates, exact-id lookup.
    'vendorCost.consistency-test',
    // Build 378 (item icm) - the [sap:abap:icm] fields as shipped: the SAP
    // client of a session-list line is sap_client, never an HTTP status (no
    // status / action), empty user / terminal columns set no field, the
    // ERROR / WARNING class is anchored, src / dest follow the connection's
    // direction, the sourcetype is in no CIM model, and the AI-facing
    // sourcetype metadata row offers no status. The conf side is 3icm.
    'icmProps.consistency-test',
    // Build 378 (item wd) - Web Dispatcher access events take sap_sid /
    // sap_instance from the log path with the ABAP stanzas' own lines (all
    // Demo Gen templates and the other path shapes), and the topology
    // inventory leaves a Web Dispatcher out: its access log by sourcetype,
    // its own ICM trace (webdispatcher/icm, which Data TA builds of 2026-10-13
    // and earlier typed sap:abap:icm; R1 reads the Data TA's transforms.conf and
    // now asserts abap/icm only) by LogServ folder, in the aggregate = backfill.
    'wdProps.consistency-test',
    // Build 377 (session 155) - the chart time basis: chooseTimechartSpan's
    // ladder, applySpanToken's 1h floor for rollup reads, the span label read
    // from the DISPATCHED query (spanSubtitle), and the KPI sparkline tooltip:
    // the Splunk user's zone read from Splunk's ISO _time, and the UTC day of
    // the beaconing points ("not yet computed" for a 0-filled UTC day that has
    // not ended). Mutation-tested 35/35. The dashboard side is 3span.
    'timechartSpan.consistency-test',
    // Build 378 (session 156, item i1) - the [sap:hana:tracelogs] search-time
    // extractions, read from props.conf and run over fixture lines of every
    // file kind (decoded and JSON-escaped): the anchored trace and backup.log
    // lines, the hdbcons timings in ms for usec / msec / sec, no severity on
    // the record files (U39), the file types. The conf side is 3conf (b).
    'hanaTraceProps.consistency-test',
    // Build 378 (session 156, lane U-topology) - the topology edge types and
    // endpoint kinds: the SAP Router type, its one colour token (perceptual, both
    // modes), the saved-layout union rule, retargetEndpoint, the per-type pane
    // text, and the conf's literal types / kinds / clause fields / tags against
    // the UI. Mutation-tested 43/43. The .tsx wiring is 3tu.
    'topologyTypes.consistency-test',
    // Build 378 (session 156, design_impact.md F1) - the Settings backfill's
    // plan: only the two tails that combine rows across their union arms (the
    // Environment Topology nodes and inventory) are staged and combined per
    // part, and the rows that writes EQUAL a single-pipeline union over the same
    // window (a row engine runs the shipped tails over synthetic arms with the
    // Demo Gen overlaps and a cross-arm SID conflict; the old per-arm dispatch,
    // run the same way, is the control that gets them wrong); a part is combined
    // only when every row its arms staged reads back (a short, empty or over-read
    // fails it); every other stanza is planned exactly as the pre-378 algorithm
    // did, item for item. Mutation-tested 54/54. The panel and conf side is 3bs.
    // Build 379 (session 160): the inventory tail keeps each entity's most recent
    // SID (newest hour, then most events; a tie keeps the old row) and the row
    // engine runs its floor() and eventstats; 10 new mutants killed.
    'backfillPlan.consistency-test',
    // Build 379 (session 160) - Host Details' work process panel: the hostrole
    // rollup stores abap_wp by the trace-component letter (wp_category; it grouped
    // by a wp_type nothing extracts, so the panel never showed), and the panel
    // names it with props.conf's EVAL-wp_category_name, held byte-equal here.
    'wpCategory.consistency-test',
    // Build 380 (session 161) - the AI Assistant's settings, acks and model
    // cache are writable by the admin tier only (metadata/default.meta), and
    // the paths a non-admin still reaches stay best-effort.
    'aiKvAcl.consistency-test',
    // Build 380 (session 161) - lookups/logserv_sourcetype_metadata.csv: every
    // App-owned row's key fields and sample fields exist (props / transforms /
    // fields.conf and the Data TA's routes), and every sample passes splGuard.
    'sourcetypeMetadata.consistency-test',
    // Build 384 (session 161) - every KV collection is written by the admin tier
    // only except the six declared open ones, the code's writers match, every
    // outputlookup saved search sets dispatchAs = user, and the refresh clamp.
    'kvAcl.consistency-test',
    // Build 386 (session 161) - each legal acknowledgement text is pinned to
    // its version in ai_assistant_acks.conf (a SHA-256 revision history), and
    // the forwarder-disabled text names the audit index correctly.
    'legalAcks.consistency-test',
    // Build 394 (session 161) - the Audit Log viewer's search re-derives user
    // from _raw after spath, so the "User contains" filter no longer shows
    // each name twice.
    'auditQuery.consistency-test',
];

let failed = false;
for (const t of TESTS) {
    const original = process.exit;
    let exitCode = 0;
    // The tests call process.exit(1) on failure; intercept so one failing test
    // still lets the drift check run and report everything in one pass.
    process.exit = (code) => {
        exitCode = code || 0;
        throw new Error('__test_exit__');
    };
    try {
        loadTs(path.join(UTILS, t));
    } catch (e) {
        if (e && e.message === '__test_exit__') {
            if (exitCode !== 0) failed = true;
        } else {
            console.error(`check-diagnostics: ${t} threw:`);
            console.error(e && e.stack ? e.stack : e);
            failed = true;
        }
    } finally {
        process.exit = original;
    }
}

// --- 2b: live check — the aggregate-scope extractor against the REAL conf ---
//
// `extractAggregateScope` is what lets the diagnostic trace a cached panel back
// to the events it summarises. It is a regex over SPL we ship, so the only test
// worth having is against that SPL — a synthetic fixture would keep passing
// while a conf rewrite silently broke the trace, and the failure mode is
// invisible (the drawer just goes back to saying "reads summarised data").
{
    const SAVEDSEARCHES = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );
    const { extractAggregateScope } = loadTs(path.join(UTILS, 'diagEvidence'));
    const { ROLLUPS } = loadTs(path.resolve(__dirname, '../src/main/webapp/pages/home/routes/rollupRegistry'));

    const conf = fs.readFileSync(SAVEDSEARCHES, 'utf8');
    // Split into stanzas; a saved search's `search =` value spans continuation
    // lines, so keep the whole stanza body and scan it.
    const stanzas = {};
    let current = null;
    for (const raw of conf.split('\n')) {
        const m = /^\[(.+)\]\s*$/.exec(raw.trim());
        if (m) {
            current = m[1];
            stanzas[current] = [];
        } else if (current) {
            stanzas[current].push(raw);
        }
    }

    const aggregates = [];
    ROLLUPS.forEach((r) => r.aggregateSearches.forEach((a) => aggregates.push([r.key, a])));

    let traced = 0;
    const blind = [];
    for (const [key, name] of aggregates) {
        if (!stanzas[name]) {
            console.error(`check-diagnostics: rollup "${key}" names a missing aggregate [${name}]`);
            failed = true;
            continue;
        }
        const scope = extractAggregateScope(stanzas[name].join('\n'));
        if (scope.sourcetypes.length > 0 || scope.tags.length > 0) traced += 1;
        else blind.push(name);
    }
    // Every aggregate should resolve to something the diagnostic can probe. If
    // one genuinely cannot, it must be listed here deliberately rather than
    // discovered by a customer whose drawer says nothing useful.
    // These four summarise the WHOLE index — "events per hour", "events by
    // host", "source → sourcetype", "events by cloud provider". They constrain
    // no sourcetype and no tag because there is nothing narrower to constrain:
    // their source IS the index. Tracing them would add nothing the
    // index-presence probe does not already answer, so they are listed here
    // rather than reported as a gap. Anything NEW appearing in this list is a
    // real regression in the trace.
    const KNOWN_UNSCOPED = [
        'logserv_mc_aggregate',
        'logserv_pipeline_aggregate',
        'logserv_hostdetails_aggregate',
        'logserv_stmap_aggregate',
    ];
    const unexpected = blind.filter((b) => KNOWN_UNSCOPED.indexOf(b) === -1);
    if (unexpected.length > 0) {
        console.error(
            `check-diagnostics: ${unexpected.length} aggregate(s) yield no probeable scope: ${unexpected.join(', ')}`,
        );
        console.error('  (the diagnostic cannot trace a cached panel back through these)');
        failed = true;
    }
    console.log(
        `check-diagnostics: aggregate-scope trace resolves ${traced}/${aggregates.length} aggregates`,
    );
}

// --- 3: live drift check against props.conf -------------------------------

const propsText = fs.readFileSync(PROPS_CONF, 'utf8');
const actual = new Set();
for (const rawLine of propsText.split('\n')) {
    const line = rawLine.trim();
    const m = /^EVAL-([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    // "yields a string boolean" == the expression produces a quoted true/false
    if (/"(?:true|false)"/.test(m[2])) actual.add(m[1]);
}

const { EVAL_STRING_BOOLEAN_FIELDS } = loadTs(path.join(UTILS, 'splProbe'));
const declared = new Set(EVAL_STRING_BOOLEAN_FIELDS);

const missing = Array.from(actual).filter((f) => !declared.has(f)).sort();
const extra = Array.from(declared).filter((f) => !actual.has(f)).sort();

if (missing.length || extra.length) {
    failed = true;
    console.error('check-diagnostics: EVAL_STRING_BOOLEAN_FIELDS has drifted from props.conf');
    if (missing.length) {
        console.error(
            `  MISSING (props.conf defines these as string booleans, splProbe.ts does not list them):\n    ${missing.join(', ')}`,
        );
        console.error(
            '    -> the numeric-vs-string-boolean lint will NOT catch a defect on these fields.',
        );
    }
    if (extra.length) {
        console.error(
            `  EXTRA (listed in splProbe.ts but not a string-boolean EVAL in props.conf):\n    ${extra.join(', ')}`,
        );
        console.error(
            '    -> the lint may FALSE-POSITIVE on correct SPL that compares these numerically.',
        );
    }
    console.error(`  Fix: update EVAL_STRING_BOOLEAN_FIELDS in ${path.relative(process.cwd(), path.join(UTILS, 'splProbe.ts'))}`);
} else {
    console.log(
        `check-diagnostics: lint table matches props.conf (${actual.size} string-boolean EVAL fields)`,
    );
}

// --- 3b: live drift check — the Data Doctor reports conf trio (build 311) ---
//
// The nightly [logserv_diag_reports_retention] rewrites every SURVIVING row
// through transforms.conf's fields_list — an unlisted field is silently
// STRIPPED, which would destroy stored report models one night after a green
// build. And the retention SPL itself is load-bearing in four places
// (override_if_empty=false, the age window, the future-junk clamp, the row
// cap): a typo leaves the search "existing" while it either wipes the
// collection or never trims it. Both expectations are DERIVED from
// diagPersistence.ts, never restated (session-093 sticky #6).
{
    const persistMod = loadTs(path.join(UTILS, 'diagPersistence'));
    const wanted = persistMod.DIAG_REPORT_FIELDS;
    const maxRows = persistMod.RETENTION_MAX_ROWS;
    const maxChars = persistMod.MAX_MODEL_JSON_CHARS;
    let trioFailed = false;
    const trioFail = (msg) => {
        trioFailed = true;
        failed = true;
        console.error(msg);
    };

    // Worst-case nightly round trip must stay well under the kvstore
    // max_size_per_result_mb=50 default — at which a truncated read would feed
    // a partial set into an overwrite (silent report deletion).
    if (maxChars * maxRows > 40000000) {
        trioFail(
            `check-diagnostics: MAX_MODEL_JSON_CHARS x RETENTION_MAX_ROWS = ${maxChars * maxRows} exceeds the 40 MB retention round-trip bound`,
        );
    }

    const TRANSFORMS = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/transforms.conf',
    );
    const COLLECTIONS = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/collections.conf',
    );
    const META = path.resolve(__dirname, '../src/main/resources/splunk/metadata/default.meta');
    const SAVEDSEARCHES = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );

    const stanzaBody = (confText, name) => {
        const lines = confText.split('\n');
        const out = [];
        let inside = false;
        for (const raw of lines) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                inside = m[1] === name;
                continue;
            }
            if (inside) out.push(raw);
        }
        return out.length > 0 ? out.join('\n') : null;
    };

    // (a) transforms.conf fields_list <-> DIAG_REPORT_FIELDS, both directions.
    const tBody = stanzaBody(fs.readFileSync(TRANSFORMS, 'utf8'), 'logserv_diag_reports');
    if (tBody === null) {
        trioFail('check-diagnostics: transforms.conf has no [logserv_diag_reports] stanza');
    } else {
        const fm = /^\s*fields_list\s*=\s*(.+)\s*$/m.exec(tBody);
        const listed = fm ? fm[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
        const listedSet = new Set(listed);
        const wantedSet = new Set(wanted);
        const missing = wanted.filter((f) => !listedSet.has(f)).sort();
        const extra = listed.filter((f) => !wantedSet.has(f)).sort();
        if (missing.length || extra.length) {
            trioFail('check-diagnostics: [logserv_diag_reports] fields_list has drifted from DIAG_REPORT_FIELDS');
            if (missing.length) {
                console.error(`  MISSING from fields_list (the nightly retention would STRIP these): ${missing.join(', ')}`);
            }
            if (extra.length) {
                console.error(`  EXTRA in fields_list (not written by diagPersistence.ts): ${extra.join(', ')}`);
            }
        }
    }

    // (b) collections.conf stanza exists and types generated_at as a number
    //     (the retention's relative_time comparison depends on it).
    const cBody = stanzaBody(fs.readFileSync(COLLECTIONS, 'utf8'), 'logserv_diag_reports');
    if (cBody === null) {
        trioFail('check-diagnostics: collections.conf has no [logserv_diag_reports] stanza (persist would fail silently forever)');
    } else if (!/^\s*field\.generated_at\s*=\s*number\s*$/m.test(cBody)) {
        trioFail('check-diagnostics: [logserv_diag_reports] must declare field.generated_at = number');
    }

    // (c) default.meta ACL stanza exists (non-admins must be able to persist).
    const metaText = fs.readFileSync(META, 'utf8');
    if (!/^\[collections\/logserv_diag_reports\]\s*$/m.test(metaText)) {
        trioFail('check-diagnostics: metadata/default.meta has no [collections/logserv_diag_reports] ACL stanza');
    }

    // (d) the retention stanza's load-bearing tokens, pinned intent-map style.
    const rBody = stanzaBody(
        fs.readFileSync(SAVEDSEARCHES, 'utf8'),
        'logserv_diag_reports_retention',
    );
    if (rBody === null) {
        trioFail('check-diagnostics: savedsearches.conf has no [logserv_diag_reports_retention] stanza');
    } else {
        const sm = /^\s*search\s*=\s*(.+)\s*$/m.exec(rBody);
        const spl = sm ? sm[1] : '';
        const requiredTokens = [
            '| inputlookup logserv_diag_reports ',
            '| where generated_at >= relative_time(now(), "-365d") AND generated_at <= now() + 86400 ',
            `| sort ${maxRows} - generated_at `,
            '| outputlookup override_if_empty=false logserv_diag_reports ',
        ];
        for (const tok of requiredTokens) {
            if (spl.indexOf(tok.trim()) === -1) {
                trioFail(`check-diagnostics: retention SPL is missing the pinned token: ${tok.trim()}`);
            }
        }
        if (!/^\s*is_scheduled\s*=\s*1\s*$/m.test(rBody)) {
            trioFail('check-diagnostics: [logserv_diag_reports_retention] must set is_scheduled = 1');
        }
        if (!/^\s*cron_schedule\s*=\s*56 1 \* \* \*\s*$/m.test(rBody)) {
            trioFail('check-diagnostics: [logserv_diag_reports_retention] cron_schedule must be 56 1 * * * (the verified-free slot)');
        }
    }

    if (!trioFailed) {
        console.log(
            `check-diagnostics: diag-reports conf trio + retention pinned (${wanted.length} fields, cap ${maxRows} rows)`,
        );
    }
}

// --- 3c: source pin — the Diagnostics page's completion-path ordering ------
//
// `endDiagnosis()` CANCELS the runner as part of releasing the singleton, so
// the page's completion handler must read `isCancelled()` BEFORE the release.
// Build 311 inverted the order: every completed run read as cancelled, was
// misclassified as an outside supersede, and the page could never render
// evidence (found by the session-097 rendered-UI pass — the .ts-only suites
// cannot render the component, so this pin is the regression guard).
{
    const DIAG_PAGE = path.resolve(
        __dirname,
        '../src/main/webapp/pages/home/dashboards/Diagnostics.tsx',
    );
    const src = fs.readFileSync(DIAG_PAGE, 'utf8');
    let pageFailed = false;
    const pageFail = (msg) => {
        pageFailed = true;
        failed = true;
        console.error(msg);
    };

    const capture = 'const wasCancelled = runner.isCancelled();';
    const capIdx = src.indexOf(capture);
    if (capIdx === -1) {
        pageFail(
            'check-diagnostics: Diagnostics.tsx must capture `const wasCancelled = runner.isCancelled();` before releasing the singleton',
        );
    } else {
        const relIdx = src.indexOf('endDiagnosis(runner);', capIdx);
        const branchIdx = src.indexOf('if (wasCancelled)', capIdx);
        if (relIdx === -1 || branchIdx === -1 || !(capIdx < relIdx && relIdx < branchIdx)) {
            pageFail(
                'check-diagnostics: Diagnostics.tsx completion path must run capture -> endDiagnosis -> branch on wasCancelled, in that order',
            );
        }
    }
    // The inverted form: branching on the LIVE flag at completion time. The
    // progress callback's `!runner.isCancelled()` guard is fine and expected;
    // a bare `if (runner.isCancelled())` is the bug shape.
    if (/if \(runner\.isCancelled\(\)\)/.test(src)) {
        pageFail(
            'check-diagnostics: Diagnostics.tsx must not branch on the live runner.isCancelled() at completion — endDiagnosis has already cancelled it (capture wasCancelled first)',
        );
    }
    if (!pageFailed) {
        console.log(
            'check-diagnostics: Diagnostics page completion-path ordering pinned (capture-before-release)',
        );
    }
}

// --- 3d: live drift check — the ingest-facts collection (build 314, §15) ---
//
// `logserv_diag_ingest_facts` ships collections.conf + metadata ACL ONLY:
// there is deliberately NO transforms.conf kvstore stanza (nothing reads it
// from SPL) and NO retention search (fixed-key overwrite; the facts do not
// age out — the UI warns instead). Those omissions are load-bearing (§15.8a):
// a future transforms stanza would create the fields_list stripping hazard,
// and a retention would need override_if_empty=false + a cron slot. Adding
// either must be a conscious change that updates this gate.
{
    const ingestMod = loadTs(path.join(UTILS, 'diagIngestFacts'));
    const wantedI = ingestMod.DIAG_INGEST_FACT_FIELDS;
    let ingestFailed = false;
    const ingestFail = (msg) => {
        ingestFailed = true;
        failed = true;
        console.error(msg);
    };

    const COLLECTIONS_I = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/collections.conf',
    );
    const TRANSFORMS_I = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/transforms.conf',
    );
    const META_I = path.resolve(__dirname, '../src/main/resources/splunk/metadata/default.meta');
    const SAVEDSEARCHES_I = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );

    const stanzaBodyI = (confText, name) => {
        const lines = confText.split('\n');
        const out = [];
        let inside = false;
        for (const raw of lines) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                inside = m[1] === name;
                continue;
            }
            if (inside) out.push(raw);
        }
        return out.length > 0 ? out.join('\n') : null;
    };

    // (a) collections.conf field.* <-> DIAG_INGEST_FACT_FIELDS (minus _key),
    //     both directions.
    const cBody = stanzaBodyI(fs.readFileSync(COLLECTIONS_I, 'utf8'), 'logserv_diag_ingest_facts');
    if (cBody === null) {
        ingestFail('check-diagnostics: collections.conf has no [logserv_diag_ingest_facts] stanza');
    } else {
        const declared = [];
        const fre = /^\s*field\.([A-Za-z0-9_]+)\s*=/gm;
        let fmatch = fre.exec(cBody);
        while (fmatch) {
            declared.push(fmatch[1]);
            fmatch = fre.exec(cBody);
        }
        const expected = wantedI.filter((f) => f !== '_key');
        const missing = expected.filter((f) => declared.indexOf(f) === -1);
        const extra = declared.filter((f) => expected.indexOf(f) === -1);
        if (missing.length > 0 || extra.length > 0) {
            ingestFail(
                `check-diagnostics: [logserv_diag_ingest_facts] fields drifted from DIAG_INGEST_FACT_FIELDS` +
                    (missing.length ? `\n  MISSING in collections.conf: ${missing.join(', ')}` : '') +
                    (extra.length ? `\n  EXTRA in collections.conf: ${extra.join(', ')}` : ''),
            );
        }
    }

    // (b) metadata ACL present (a non-admin must be able to paste).
    const metaI = fs.readFileSync(META_I, 'utf8');
    if (metaI.indexOf('[collections/logserv_diag_ingest_facts]') === -1) {
        ingestFail('check-diagnostics: default.meta has no [collections/logserv_diag_ingest_facts] ACL');
    }

    // (c) the DELIBERATE OMISSIONS, asserted.
    if (fs.readFileSync(TRANSFORMS_I, 'utf8').indexOf('[logserv_diag_ingest_facts]') !== -1) {
        ingestFail(
            'check-diagnostics: transforms.conf gained a [logserv_diag_ingest_facts] stanza — the omission is deliberate (§15.8a); update the gate consciously if this is intended',
        );
    }
    if (fs.readFileSync(SAVEDSEARCHES_I, 'utf8').indexOf('logserv_diag_ingest_facts') !== -1) {
        ingestFail(
            'check-diagnostics: savedsearches.conf references logserv_diag_ingest_facts — no retention/SPL consumer may exist (§15.8a); update the gate consciously if this is intended',
        );
    }

    if (!ingestFailed) {
        console.log(
            `check-diagnostics: ingest-facts conf pinned (${wantedI.length - 1} fields; transforms + retention absent by design)`,
        );
    }
}

// --- 3e: the clz-map derive gate (build 314, §15.4 + §15.8a-31) -------------
//
// Check 29 ships SOURCETYPE_CLZ_MAP as a constant because the SH webapp
// cannot read the Data TA's transforms.conf at runtime — but the BUILD can:
// both packages live in this snapshot. The expectation is DERIVED from the
// Data TA's `@logserv_filter` annotations + `FORMAT = sourcetype::…` routing
// lines and compared BOTH WAYS (session-093 sticky #6). HARD-FAIL when the
// Data TA source is missing: it is a build-time requirement of the App
// workspace from build 314 on — a silent skip would let the map rot exactly
// when nobody is looking.
{
    const ingestMod2 = loadTs(path.join(UTILS, 'diagIngestFacts'));
    const shipped = ingestMod2.SOURCETYPE_CLZ_MAP;
    const DATA_TA_TRANSFORMS = path.resolve(
        __dirname,
        '../../../../splunk_ta_sap_logserv/package/default/transforms.conf',
    );
    if (!fs.existsSync(DATA_TA_TRANSFORMS)) {
        failed = true;
        console.error(
            'check-diagnostics: the Data TA source is missing at\n  ' +
                DATA_TA_TRANSFORMS +
                '\nThe clz-map drift gate (design §15.4) derives its expectation from that file; from ' +
                'build 314 the Data TA source sibling is a build-time requirement of the App workspace.',
        );
    } else {
        const taText = fs.readFileSync(DATA_TA_TRANSFORMS, 'utf8');
        const lines = taText.split('\n');
        const derived = {};
        let pending = null;
        for (const raw of lines) {
            const am = /^#\s*@logserv_filter:\s*(.+)$/.exec(raw.trim());
            if (am) {
                pending = am[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                continue;
            }
            const fm2 = /^FORMAT\s*=\s*sourcetype::(.+)$/.exec(raw.trim());
            if (fm2 && pending !== null) {
                const st = fm2[1].trim();
                if (!derived[st]) derived[st] = [];
                for (const pth of pending) {
                    if (derived[st].indexOf(pth) === -1) derived[st].push(pth);
                }
                pending = null;
            }
        }
        const dKeys = Object.keys(derived).sort();
        const sKeys = Object.keys(shipped).sort();
        const missingSt = dKeys.filter((k) => sKeys.indexOf(k) === -1);
        const extraSt = sKeys.filter((k) => dKeys.indexOf(k) === -1);
        let clzFailed = false;
        if (missingSt.length > 0 || extraSt.length > 0) {
            clzFailed = true;
            failed = true;
            console.error(
                'check-diagnostics: SOURCETYPE_CLZ_MAP drifted from the Data TA routing annotations' +
                    (missingSt.length ? `\n  MISSING in the shipped map: ${missingSt.join(', ')}` : '') +
                    (extraSt.length ? `\n  EXTRA in the shipped map: ${extraSt.join(', ')}` : ''),
            );
        } else {
            for (const st of dKeys) {
                const a = derived[st].slice().sort().join('|');
                const b = shipped[st].slice().sort().join('|');
                if (a !== b) {
                    clzFailed = true;
                    failed = true;
                    console.error(
                        `check-diagnostics: SOURCETYPE_CLZ_MAP['${st}'] paths drifted:\n  Data TA: ${a}\n  shipped: ${b}`,
                    );
                }
            }
        }
        if (!clzFailed) {
            console.log(
                `check-diagnostics: clz map derived from the Data TA matches (${sKeys.length} sourcetypes)`,
            );
        }
        // --- 3e (session 155, App build 377, design item j): the NO-FOLDER
        // routes. A routing stanza whose `FORMAT = sourcetype::X` has no
        // `@logserv_filter` annotation pending and whose REGEX keys on the
        // envelope's "source" value routes events that carry NO folder
        // fields (today [set_srctype_hana_tracelogs_by_source]). Check 29
        // reasons about them through SOURCETYPE_NOFOLDER_SOURCES, so its keys
        // must equal the derived set BOTH WAYS. An un-annotated sourcetype
        // route that does not key on "source" declares no folder and no
        // source either: it fails too (it would be invisible to check 29).
        {
            const shippedNf = Object.keys(ingestMod2.SOURCETYPE_NOFOLDER_SOURCES || {}).sort();
            const derivedNf = [];
            const unkeyedNf = [];
            let pendingNf = null;
            let stanzaNf = '';
            let regexNf = '';
            for (const raw of lines) {
                const tl = raw.trim();
                const anm = /^#\s*@logserv_filter:\s*(.+)$/.exec(tl);
                if (anm) {
                    pendingNf = anm[1];
                    continue;
                }
                const hm = /^\[([^\]]+)\]$/.exec(tl);
                if (hm) {
                    stanzaNf = hm[1];
                    regexNf = '';
                    continue;
                }
                const rm = /^REGEX\s*=\s*(.*)$/.exec(tl);
                if (rm) {
                    regexNf = rm[1];
                    continue;
                }
                const fm3 = /^FORMAT\s*=\s*sourcetype::(.+)$/.exec(tl);
                if (fm3) {
                    if (pendingNf === null) {
                        const st = fm3[1].trim();
                        if (regexNf.indexOf('"source"') === -1) unkeyedNf.push(`[${stanzaNf}] -> ${st}`);
                        else if (derivedNf.indexOf(st) === -1) derivedNf.push(st);
                    }
                    pendingNf = null;
                }
            }
            derivedNf.sort();
            const missingNf = derivedNf.filter((k) => shippedNf.indexOf(k) === -1);
            const extraNf = shippedNf.filter((k) => derivedNf.indexOf(k) === -1);
            if (missingNf.length > 0 || extraNf.length > 0 || unkeyedNf.length > 0) {
                failed = true;
                console.error(
                    'check-diagnostics: SOURCETYPE_NOFOLDER_SOURCES drifted from the Data TA no-folder routes ' +
                        '(un-annotated routing stanzas keyed on "source")' +
                        (missingNf.length ? `\n  MISSING in the shipped map: ${missingNf.join(', ')}` : '') +
                        (extraNf.length ? `\n  EXTRA in the shipped map: ${extraNf.join(', ')}` : '') +
                        (unkeyedNf.length
                            ? `\n  un-annotated routing stanza(s) keyed on neither a folder nor "source": ${unkeyedNf.join(', ')}`
                            : ''),
                );
            } else {
                console.log(
                    `check-diagnostics: no-folder routes derived from the Data TA match (${shippedNf.length} sourcetype${shippedNf.length === 1 ? '' : 's'})`,
                );
            }
        }
    }
}

// --- 3e-2: the S3 Direct dashboard table (session 135, S3 design note §18.8) --
//
// The Data TA's AWS S3 Direct screen offers this App's Settings -> Dashboard
// Data rows and reads the S3 folders each one is built from. It runs on a
// heavy forwarder, which cannot read this App, so the table ships in the Data
// TA's logserv_s3_direct.js as strict JSON between two marker comments. This
// gate re-derives it the way that design says - ROLLUPS_SORTED x
// extractAggregateScope over each row's aggregate AND backfill stanzas x
// SOURCETYPE_CLZ_MAP / TAG_CLZ_MAP, a row whose searches constrain nothing
// reading every folder - and fails on any difference in rows, order, labels or
// folders. It also holds the screen's CLZ_PAIRS to the routed set, which check
// 29 above ties to the Data TA's own annotations. HARD-FAIL when the script is
// missing, like check 29. LOGSERV_S3_DIRECT_JS overrides the path, so the
// gate's control runs can point it at a pre-change or deliberately drifted copy.
{
    let s3Failed = false;
    const s3Fail = (msg) => {
        s3Failed = true;
        failed = true;
        console.error(msg);
    };
    const S3_JS = process.env.LOGSERV_S3_DIRECT_JS || path.resolve(
        __dirname,
        '../../../../splunk_ta_sap_logserv/package/appserver/static/logserv_s3_direct.js',
    );
    if (!fs.existsSync(S3_JS)) {
        s3Fail(`check-diagnostics: the Data TA's S3 Direct script is missing at\n  ${S3_JS}`);
    } else {
        const s3Text = fs.readFileSync(S3_JS, 'utf8');
        const tm = /\/\* BEGIN ROLLUP_FOLDERS \*\/\s*var ROLLUP_FOLDERS = ([\s\S]*?);\s*\/\* END ROLLUP_FOLDERS \*\//.exec(s3Text);
        let shippedRows = null;
        if (!tm) {
            s3Fail('check-diagnostics: logserv_s3_direct.js carries no ROLLUP_FOLDERS table between its markers');
        } else {
            try {
                shippedRows = JSON.parse(tm[1]);
            } catch (e) {
                s3Fail(`check-diagnostics: the ROLLUP_FOLDERS table in logserv_s3_direct.js is not strict JSON (${e.message})`);
            }
        }
        const pm = /var CLZ_PAIRS = \[([\s\S]*?)\];/.exec(s3Text);
        const shippedPairs = pm ? (pm[1].match(/'([^']+)'/g) || []).map((q) => q.slice(1, -1)) : null;

        const { extractAggregateScope } = loadTs(path.join(UTILS, 'diagEvidence'));
        const { ROLLUPS_SORTED } = loadTs(path.resolve(__dirname, '../src/main/webapp/pages/home/routes/rollupRegistry'));
        const { SOURCETYPE_CLZ_MAP, TAG_CLZ_MAP } = loadTs(path.join(UTILS, 'diagIngestFacts'));
        const ssText = fs.readFileSync(
            path.resolve(__dirname, '../src/main/resources/splunk/default/savedsearches.conf'),
            'utf8',
        );
        const stanzaBody = {};
        let current = null;
        for (const raw of ssText.split('\n')) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                current = m[1];
                stanzaBody[current] = [];
            } else if (current) {
                stanzaBody[current].push(raw);
            }
        }
        const uniqSorted = (a) => Array.from(new Set(a)).sort();
        const ALL = uniqSorted([].concat(...Object.values(SOURCETYPE_CLZ_MAP)));
        // A known drift: folders the App derives for a row before the Data TA's table
        // (shipped by its own UCC build) lists them. Exactly those folders, missing
        // from exactly that row, are reported as a known drift instead of a failure.
        // Any other difference still fails, and so does an entry here once the Data
        // TA's table lists its folders, or once the App has no such row: delete the
        // entry then. Build 378 recorded topology_detail / topology_graph lacking
        // sap/saprouter (the SAP Router edges, router and target nodes, sapms<SID>
        // inventory arm); the Data TA build of 2026-10-16 lists it, so none is open.
        const KNOWN_S3_DRIFT = {};
        const knownS3 = [];
        const expected = ROLLUPS_SORTED.map((r) => {
            let sts = [];
            let tags = [];
            for (const name of r.aggregateSearches.concat(r.backfillStanzas)) {
                if (!stanzaBody[name]) {
                    s3Fail(`check-diagnostics: rollup "${r.key}" names a missing stanza [${name}]`);
                    continue;
                }
                const sc = extractAggregateScope(stanzaBody[name].join('\n'));
                sts = sts.concat(sc.sourcetypes);
                tags = tags.concat(sc.tags);
            }
            let folders = [];
            sts.forEach((s) => { folders = folders.concat(SOURCETYPE_CLZ_MAP[s] || []); });
            tags.forEach((t) => { folders = folders.concat(TAG_CLZ_MAP[t] || []); });
            const unscoped = sts.length === 0 && tags.length === 0;
            return { key: r.key, label: r.label, folders: unscoped ? ALL : uniqSorted(folders) };
        });

        if (shippedRows) {
            const want = expected.map((r) => r.key).join(',');
            const got = shippedRows.map((r) => r.key).join(',');
            if (want !== got) {
                s3Fail(
                    "check-diagnostics: S3 Direct ROLLUP_FOLDERS rows drifted from the App's rollups (order included)" +
                        `\n  App:     ${want}\n  Data TA: ${got}`,
                );
            } else {
                expected.forEach((r, i) => {
                    const sh = shippedRows[i];
                    if (sh.label !== r.label) {
                        s3Fail(
                            `check-diagnostics: S3 Direct ROLLUP_FOLDERS['${r.key}'] label drifted:` +
                                `\n  App:     ${r.label}\n  Data TA: ${sh.label}`,
                        );
                    }
                    const a = r.folders.join('|');
                    const b = (sh.folders || []).join('|');
                    const known = KNOWN_S3_DRIFT[r.key] || [];
                    const shFolders = sh.folders || [];
                    if (known.length > 0 && known.every((f) => shFolders.indexOf(f) !== -1)) {
                        s3Fail(
                            `check-diagnostics: S3 Direct ROLLUP_FOLDERS['${r.key}'] now lists ${known.join(', ')}:`
                                + ' remove its KNOWN_S3_DRIFT entry from gate 3e-2',
                        );
                    } else if (known.length > 0 && known.every((f) => r.folders.indexOf(f) !== -1)
                        && !known.some((f) => shFolders.indexOf(f) !== -1)
                        && r.folders.filter((f) => known.indexOf(f) === -1).join('|') === b) {
                        knownS3.push(`${r.key} lacks ${known.join(', ')}`);
                    } else if (a !== b) {
                        s3Fail(
                            `check-diagnostics: S3 Direct ROLLUP_FOLDERS['${r.key}'] folders drifted:` +
                                `\n  App:     ${a}\n  Data TA: ${b}`,
                        );
                    }
                });
                Object.keys(KNOWN_S3_DRIFT).filter((k) => !expected.some((r) => r.key === k)).forEach((k) => {
                    s3Fail(`check-diagnostics: KNOWN_S3_DRIFT names '${k}', which is no App rollup: remove the entry`);
                });
            }
        }
        if (!shippedPairs) {
            s3Fail('check-diagnostics: logserv_s3_direct.js carries no CLZ_PAIRS list');
        } else if (shippedPairs.length !== ALL.length || uniqSorted(shippedPairs).join('|') !== ALL.join('|')) {
            s3Fail(
                'check-diagnostics: S3 Direct CLZ_PAIRS drifted from the routed set' +
                    `\n  routed:  ${ALL.join(', ')}\n  Data TA: ${shippedPairs.join(', ')}`,
            );
        }
        if (!s3Failed) {
            console.log(
                `check-diagnostics: S3 Direct dashboard table matches the App's rollups (${expected.length} rows, ${ALL.length} folders)`
                    + (knownS3.length ? `; KNOWN DRIFT until the Data TA's next build: ${knownS3.join('; ')}` : ''),
            );
        }
    }
}

// --- 3f: the Tier B platform-snapshot conf gates (build 315, SS16) ----------
//
// The snapshot collection needs ALL THREE conf files (its retention rewrites
// rows through the transforms fields_list — the OPPOSITE of the ingest-facts
// omissions), the aggregate/retention SPL carries load-bearing tokens the
// review pinned (SS16.8a-3/4/7/11), and the cron layout must stay
// collision-free — the census that used to live in testing/ is permanent here.
{
    let snapFailed = false;
    const snapFail = (msg) => {
        snapFailed = true;
        failed = true;
        console.error(msg);
    };
    const COLLECTIONS_S = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/collections.conf',
    );
    const TRANSFORMS_S = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/transforms.conf',
    );
    const META_S = path.resolve(__dirname, '../src/main/resources/splunk/metadata/default.meta');
    const SAVED_S = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );
    const SNAP_FIELDS = [
        'bucket_ts',
        'metric',
        'scope',
        'scope2',
        'n',
        'sum_rt',
        'max_rt',
        'kb',
        'ev',
        'detail',
    ];

    const stanzaBodyS = (confText, name) => {
        const lines = confText.split('\n');
        const out = [];
        let inside = false;
        for (const raw of lines) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                inside = m[1] === name;
                continue;
            }
            if (inside) out.push(raw);
        }
        return out.length > 0 ? out.join('\n') : null;
    };

    // (a) collections.conf fields, both directions.
    const cB = stanzaBodyS(fs.readFileSync(COLLECTIONS_S, 'utf8'), 'logserv_diag_platform_snapshot');
    if (cB === null) {
        snapFail('check-diagnostics: collections.conf has no [logserv_diag_platform_snapshot]');
    } else {
        const declared = [];
        const fre = /^\s*field\.([A-Za-z0-9_]+)\s*=/gm;
        let fm = fre.exec(cB);
        while (fm) {
            declared.push(fm[1]);
            fm = fre.exec(cB);
        }
        const missing = SNAP_FIELDS.filter((f) => declared.indexOf(f) === -1);
        const extra = declared.filter((f) => SNAP_FIELDS.indexOf(f) === -1);
        if (missing.length > 0 || extra.length > 0) {
            snapFail(
                'check-diagnostics: [logserv_diag_platform_snapshot] fields drifted' +
                    (missing.length ? `\n  MISSING: ${missing.join(', ')}` : '') +
                    (extra.length ? `\n  EXTRA: ${extra.join(', ')}` : ''),
            );
        }
    }
    // (b) transforms kvstore stanza with the FULL fields_list (_key first).
    const tB = stanzaBodyS(fs.readFileSync(TRANSFORMS_S, 'utf8'), 'logserv_diag_platform_snapshot');
    if (tB === null) {
        snapFail('check-diagnostics: transforms.conf has no [logserv_diag_platform_snapshot]');
    } else {
        const flm = /fields_list\s*=\s*(.+)/.exec(tB);
        const listed = flm ? flm[1].split(',').map((s) => s.trim()) : [];
        const wantedL = ['_key'].concat(SNAP_FIELDS);
        if (listed.join('|') !== wantedL.join('|')) {
            snapFail(
                `check-diagnostics: snapshot fields_list drifted\n  wanted: ${wantedL.join(', ')}\n  found:  ${listed.join(', ')}`,
            );
        }
    }
    // (c) metadata ACL + export = system (sibling parity, SS16.8a-12).
    const mB = fs.readFileSync(META_S, 'utf8');
    const mIdx = mB.indexOf('[collections/logserv_diag_platform_snapshot]');
    if (mIdx === -1) {
        snapFail('check-diagnostics: default.meta has no snapshot collection ACL');
    } else if (mB.slice(mIdx, mIdx + 400).indexOf('export = system') === -1) {
        snapFail('check-diagnostics: the snapshot meta stanza lacks export = system');
    }
    // (d) the aggregate/retention SPL + cron pins.
    const sTxt = fs.readFileSync(SAVED_S, 'utf8');
    const aggB = stanzaBodyS(sTxt, 'logserv_diag_platform_aggregate');
    const retB = stanzaBodyS(sTxt, 'logserv_diag_platform_retention');
    if (!aggB || !retB) {
        snapFail('check-diagnostics: the snapshot aggregate/retention stanzas are missing');
    } else {
        const aggSpl = (/^search\s*=\s*(.+)$/m.exec(aggB) || [])[1] || '';
        const pins = [
            ['cron 2 * * * *', aggB.indexOf('cron_schedule = 2 * * * *') !== -1],
            ['retention cron 58 1 * * *', retB.indexOf('cron_schedule = 58 1 * * *') !== -1],
            [
                'skip predicate status IN (skipped,deferred)',
                aggSpl.indexOf('status IN ("skipped","deferred")') !== -1,
            ],
            [
                'quota phrase anchor',
                aggSpl.indexOf('"maximum number of historical searches"') !== -1,
            ],
            [
                'null-proof key (fillnull before sha1)',
                aggSpl.indexOf('fillnull value="(none)" scope, scope2') !== -1 &&
                    aggSpl.indexOf('sha1(metric.":".scope.":".scope2)') !== -1,
            ],
            ['7 sentinel arms (appendpipe)', (aggSpl.match(/appendpipe/g) || []).length === 7],
            [
                'retention row cap 120000',
                retB.indexOf('sort 120000 - bucket_ts') !== -1,
            ],
            [
                'retention override_if_empty=false',
                retB.indexOf('override_if_empty=false') !== -1,
            ],
            ['retention future clamp', retB.indexOf('bucket_ts <= now() + 86400') !== -1],
        ];
        for (const [name, ok] of pins) {
            if (!ok) snapFail(`check-diagnostics: snapshot pin failed: ${name}`);
        }
    }
    // (e) the ES anomaly re-cron pins (SS16.1/SS16.8a-13) — reverting any of
    //     them re-creates the :02 collision the census below would also catch,
    //     but naming them here makes the failure actionable.
    for (const h of [2, 3, 4, 5]) {
        if (sTxt.indexOf(`cron_schedule = 30 ${h} * * *`) === -1) {
            snapFail(`check-diagnostics: anomaly re-cron pin failed (30 ${h} * * *)`);
        }
    }
    // (f) THE CRON CENSUS — permanent. Expand every ENABLED cron over the
    //     24x60 space; any collision fails the build (sessions 061-101).
    {
        const stanzas = {};
        let cur = null;
        for (const raw of sTxt.split('\n')) {
            const sm = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (sm) {
                cur = sm[1];
                stanzas[cur] = {};
                continue;
            }
            if (!cur) continue;
            const km = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(raw);
            if (km && !(km[1] in stanzas[cur])) stanzas[cur][km[1]] = km[2].trim();
        }
        const expand = (field, lo, hi) => {
            const out = new Set();
            for (const part of field.split(',')) {
                let p = part.trim();
                let step = 1;
                if (p.indexOf('/') !== -1) {
                    const bits = p.split('/');
                    p = bits[0];
                    step = parseInt(bits[1], 10);
                }
                let a = lo;
                let b = hi;
                if (p !== '*') {
                    if (p.indexOf('-') !== -1) {
                        const r = p.split('-');
                        a = parseInt(r[0], 10);
                        b = parseInt(r[1], 10);
                    } else {
                        a = parseInt(p, 10);
                        b = a;
                    }
                }
                for (let v = a; v <= b; v += step) out.add(v);
            }
            return out;
        };
        const grid = {};
        let enabledCount = 0;
        for (const name of Object.keys(stanzas)) {
            const st = stanzas[name];
            const cron = st.cron_schedule;
            if (!cron) continue;
            const dis = st.disabled || '0';
            if (dis === '1' || dis === 'true' || dis === 'True') continue;
            const f = cron.split(/\s+/);
            if (f.length !== 5) {
                snapFail(`check-diagnostics: unparseable cron on ${name}: ${cron}`);
                continue;
            }
            enabledCount += 1;
            const mins = expand(f[0], 0, 59);
            const hrs = expand(f[1], 0, 23);
            hrs.forEach((h) => {
                mins.forEach((m) => {
                    const key = `${h}:${m}`;
                    if (!grid[key]) grid[key] = [];
                    grid[key].push(name);
                });
            });
        }
        const collisions = Object.keys(grid).filter((k) => grid[k].length > 1);
        if (collisions.length > 0) {
            snapFail(
                `check-diagnostics: CRON COLLISIONS (${collisions.length}):\n` +
                    collisions
                        .slice(0, 10)
                        .map((k) => `  ${k} -> ${grid[k].join(', ')}`)
                        .join('\n'),
            );
        } else if (!snapFailed) {
            console.log(
                `check-diagnostics: cron census clean (${enabledCount} enabled scheduled searches, 0 collisions)`,
            );
        }
    }
    if (!snapFailed) {
        console.log(
            'check-diagnostics: platform-snapshot conf trio + SPL pins verified (SS16)',
        );
    }
}

// --- 3g: the cp1252 gate over the report-reaching modules (SS16.8a-24) ------
//
// The PDF uses jsPDF's standard-14 fonts (WinAnsi/cp1252). Any code point a
// STRING LITERAL carries outside cp1252 renders as mojibake in the artifact.
// Curly quotes / en-em dashes / ellipsis / middot are IN cp1252 and pass; the
// pinned regression is U+2192 (the arrow this build swept out). Comments are
// stripped first — only string content ships.
{
    const CP1252_ONLY = [
        'diagReport.ts',
        'diagCascade.ts',
        'diagEvidence.ts',
        'diagEnvironment.ts',
        'diagPlatform.ts',
        'diagSweep.ts',
        'diagIngestFacts.ts',
    ];
    // cp1252 = 0x00-0xFF minus the 5 undefined slots, PLUS the 27 remapped
    // 0x80-0x9F glyphs. Practical test: encodable iff in latin-1 OR one of the
    // cp1252-specific set.
    const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
    const isCp1252 = (ch) => {
        const cp = ch.codePointAt(0);
        if (cp <= 0x7f) return true;
        if (cp >= 0xa0 && cp <= 0xff) return true;
        return CP1252_EXTRA.indexOf(ch) !== -1;
    };
    let cpFailed = false;
    for (const f of CP1252_ONLY) {
        const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
        // strip block + line comments (string-aware enough for this codebase:
        // no comment markers appear inside the diag modules' literals).
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const badChars = {};
        for (const ch of stripped) {
            if (ch === '\n' || ch === '\r' || ch === '\t') continue;
            if (!isCp1252(ch)) badChars[ch] = (badChars[ch] || 0) + 1;
        }
        const keys = Object.keys(badChars);
        if (keys.length > 0) {
            cpFailed = true;
            failed = true;
            console.error(
                `check-diagnostics: ${f} carries non-cp1252 code points outside comments: ` +
                    keys.map((k) => `U+${k.codePointAt(0).toString(16)} x${badChars[k]}`).join(', '),
            );
        }
    }
    if (!cpFailed) {
        console.log(
            `check-diagnostics: cp1252 gate clean over ${CP1252_ONLY.length} report-reaching modules`,
        );
    }
}

// --- 3h: the drawer route-close pin (SS16.8a-30, C10) -----------------------
//
// The gate resolver loads .ts only (SS12.11), so the drawer's fix is pinned at
// SOURCE level: the router-driven close must exist (useLocation + the effect
// on pathname/search), and no hashchange listener may replace it (pushState
// navigation never fires hashchange).
{
    const drawerSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/main/webapp/pages/home/state/DiagnosticDrawerProvider.tsx'),
        'utf8',
    );
    let drFailed = false;
    if (drawerSrc.indexOf('useLocation') === -1 || drawerSrc.indexOf('location.pathname, location.search') === -1) {
        drFailed = true;
        failed = true;
        console.error(
            'check-diagnostics: the drawer route-close (useLocation effect on pathname/search) is missing (SS16.8a-30)',
        );
    }
    if (/addEventListener\(\s*['"]hashchange['"]/.test(drawerSrc)) {
        drFailed = true;
        failed = true;
        console.error(
            'check-diagnostics: the drawer gained a hashchange listener — pushState navigation never fires it; the router-driven close is the fix (SS16.8a-30)',
        );
    }
    if (!drFailed) {
        console.log('check-diagnostics: drawer route-close pinned (useLocation, no hashchange)');
    }
}

// --- 3i: Phase 5 deep-evidence source pins (§17.8a) -------------------------
//
// Source-level because the gate resolver loads .ts only (SS12.11). Pins the
// raw-twin plumbing, the sweep's deep-probe abstinence, and the audit_action fix.
{
    const HOME = path.resolve(__dirname, '../src/main/webapp/pages/home');
    let p5Failed = false;
    const p5fail = (m) => {
        p5Failed = true;
        failed = true;
        console.error(`check-diagnostics: ${m}`);
    };
    // (a) The raw-twin module is React-free (gate-safe; §17.8a-16).
    const twinSrc = fs.readFileSync(path.join(HOME, 'utils/rawTwin.ts'), 'utf8');
    if (/from ['"]react['"]|\.tsx['"]/.test(twinSrc)) {
        p5fail('utils/rawTwin.ts must be React-free / import no .tsx (SS12.11 / §17.8a-16)');
    }
    // (b) The six inline-routed panels each record their twin (§17.8a-17): every
    //     dashboard that routes inline via shouldUseRawSource must also call
    //     recordRawTwin, so a new inline panel cannot silently drop check 21.
    const DASH = path.join(HOME, 'dashboards');
    for (const f of fs.readdirSync(DASH).filter((n) => n.endsWith('.tsx'))) {
        const src = fs.readFileSync(path.join(DASH, f), 'utf8');
        if (src.indexOf('shouldUseRawSource') !== -1 && src.indexOf('recordRawTwin') === -1) {
            p5fail(`${f} routes inline via shouldUseRawSource but never calls recordRawTwin (§17.8a-17)`);
        }
    }
    // (c) The sweep must NEVER run deep probes (§17.8a-16): only the drawer does.
    const sweepSrc = fs.readFileSync(path.join(HOME, 'utils/diagSweep.ts'), 'utf8');
    if (/deep\s*:\s*true/.test(sweepSrc)) {
        p5fail('diagSweep.ts passes deep:true — deep probes are drawer-only (§17.8a-16)');
    }
    const drawerSrc2 = fs.readFileSync(path.join(HOME, 'state/DiagnosticDrawerProvider.tsx'), 'utf8');
    if (drawerSrc2.indexOf('deep: true') === -1) {
        p5fail('DiagnosticDrawerProvider must pass deep:true to gatherPanelEvidence (§17.8a-16)');
    }
    // (d) The live audit_action defect fix stays (§17.8a-21): action_type, never
    //     the field that is defined nowhere.
    const ehSrc = fs.readFileSync(path.join(DASH, 'EnvironmentHealth.tsx'), 'utf8');
    if (ehSrc.indexOf('audit_action') !== -1) {
        p5fail('EnvironmentHealth.tsx reintroduced the dead `audit_action` field (§17.8a-21; use action_type)');
    }
    // (e) The grouped-arm gate for check 21 is present (§17.8a-1): a scalar twin
    //     carries no row-count signal, so the diagEvidence probe must gate on shape.
    const evSrc = fs.readFileSync(path.join(HOME, 'utils/diagEvidence.ts'), 'utf8');
    if (evSrc.indexOf('scalar raw arm') === -1) {
        p5fail('diagEvidence check 21 lost its grouped-arm gate (§17.8a-1)');
    }
    if (!p5Failed) {
        console.log('check-diagnostics: Phase 5 deep-evidence source pins clean (§17.8a)');
    }
}

// --- 3j: Phase 6 partial-data pins (§18 / §18.8a) ---------------------------
//
// (1) The verdict-id classification DRIFT check (§18.8a-20): every `id:`
//     literal in diagCascade.ts + panelDiagnosis.ts must be classified into
//     exactly one of EMPTINESS_VERDICT_IDS / PARTIAL_ALLOWED_VERDICT_IDS —
//     placeholders produced through notEvaluated() and the dynamic `lint-*`
//     family are mode-neutral by construction. A new unclassified id fails the
//     build instead of silently escaping the partial-mode invariant.
// (2) Source pins for the .tsx-resident §18.8a rules (the gate's TS loader
//     runs .ts only): the toolbar/KPI click-handler guards, the coverage
//     recorders, the drawer's mode plumbing + unknown-refusal, the sweep's
//     partial-abstinence, and the report-safety "no rows on PanelFacts" rule.
{
    const HOME = path.resolve(__dirname, '../src/main/webapp/pages/home');
    let p6Failed = false;
    const p6fail = (m) => {
        p6Failed = true;
        failed = true;
        console.error(`check-diagnostics: ${m}`);
    };

    const cascadeMod = loadTs(path.join(UTILS, 'diagCascade'));
    const empSet = new Set(cascadeMod.EMPTINESS_VERDICT_IDS || []);
    const partSet = new Set(cascadeMod.PARTIAL_ALLOWED_VERDICT_IDS || []);
    const cascadeSrc = fs.readFileSync(path.join(HOME, 'utils/diagCascade.ts'), 'utf8');
    const pdSrc = fs.readFileSync(path.join(HOME, 'utils/panelDiagnosis.ts'), 'utf8');
    const idRe = /\bid: '([a-z0-9-]+)'/g;
    const literals = new Set();
    for (const src of [cascadeSrc, pdSrc]) {
        let m = idRe.exec(src);
        while (m) {
            literals.add(m[1]);
            m = idRe.exec(src);
        }
        idRe.lastIndex = 0;
    }
    // Ids created only through notEvaluated(...) are mode-neutral placeholders.
    const neRe = /notEvaluated\(\s*\n?\s*'([a-z0-9-]+)'/g;
    const neutral = new Set();
    for (const src of [cascadeSrc, pdSrc]) {
        let m = neRe.exec(src);
        while (m) {
            neutral.add(m[1]);
            m = neRe.exec(src);
        }
        neRe.lastIndex = 0;
    }
    const unclassified = [];
    literals.forEach((id) => {
        const inEmp = empSet.has(id);
        const inPart = partSet.has(id);
        if (inEmp && inPart) p6fail(`verdict id '${id}' classified in BOTH partial sets (§18.8a-20)`);
        if (!inEmp && !inPart && !neutral.has(id)) unclassified.push(id);
    });
    if (unclassified.length > 0) {
        p6fail(`unclassified verdict id(s) — add to EMPTINESS_VERDICT_IDS or PARTIAL_ALLOWED_VERDICT_IDS: ${unclassified.join(', ')} (§18.8a-20)`);
    }

    // (2a) PanelFacts must carry NO rows field — the report builder serialises
    //      facts wholesale; rows on it would leak values into the PDF/JSON/KV
    //      (§18.8a-1, review blockers H-F2/W-1).
    const factsBlock = pdSrc.split('export interface PanelFacts')[1] || '';
    if (/\brows\??:/.test(factsBlock.split('}')[0] || '')) {
        p6fail('PanelFacts carries a rows field — row values would reach every report (§18.8a-1)');
    }
    // (2b) The toolbar + KPI click handlers keep the imperative singleton guard
    //      (§18.8a-24 — the render-time disable is an affordance, not the guard).
    const pmSrc = fs.readFileSync(path.join(HOME, 'components/PanelMeta.tsx'), 'utf8');
    if (!/isDiagnosisActive\(\)\) return;/.test(pmSrc)) {
        p6fail('PanelActions lost the imperative isDiagnosisActive() click guard (§18.8a-24)');
    }
    const kpiSrc = fs.readFileSync(path.join(HOME, 'components/KpiCard.tsx'), 'utf8');
    if (!/isDiagnosisActive\(\)\) return;/.test(kpiSrc)) {
        p6fail('KpiCard lost the imperative isDiagnosisActive() click guard (§18.8a-24)');
    }
    // (2c) KpiCard keeps the interactive-descendant guard on BOTH click and
    //      keydown (§18.8a-25 — Enter on the nested button must not drill down).
    if (!/closest\('button, a, input/.test(kpiSrc) || !/e\.target !== e\.currentTarget\) return;/.test(kpiSrc)) {
        p6fail('KpiCard lost the interactive-descendant guard on click/keydown (§18.8a-25)');
    }
    // (2d) The renderers publish the coverage summary (§18.8a-2).
    const dtSrc = fs.readFileSync(path.join(HOME, 'components/DataTable.tsx'), 'utf8');
    if (dtSrc.indexOf('recordColumnCoverage') === -1) {
        p6fail('DataTable no longer records column coverage (§18.8a-2)');
    }
    const twSrc = fs.readFileSync(path.join(HOME, 'components/TraceWaterfall.tsx'), 'utf8');
    if (twSrc.indexOf('recordColumnCoverage') === -1) {
        p6fail('TraceWaterfall no longer records column coverage (§18.8a-2)');
    }
    // (2e) The drawer derives its mode + refuses to dispatch on unknown
    //      windows (§18.8a-5/6).
    const drawerSrc3 = fs.readFileSync(path.join(HOME, 'state/DiagnosticDrawerProvider.tsx'), 'utf8');
    if (!/diagnosisMode\(req\.facts\)/.test(drawerSrc3) || !/if \(refused\)/.test(drawerSrc3)) {
        p6fail('the drawer lost its mode derivation / unknown-window refusal (§18.8a-5/6)');
    }
    if (!/mode: mode === 'partial' \? 'partial' : 'empty'/.test(drawerSrc3)) {
        p6fail('the drawer no longer passes the gather mode (§18.8a-23)');
    }
    // (2f) The sweep never enters partial mode (§18.9 — empty-only by design).
    const sweepSrc2 = fs.readFileSync(path.join(HOME, 'utils/diagSweep.ts'), 'utf8');
    if (/mode\s*:\s*'partial'/.test(sweepSrc2)) {
        p6fail('diagSweep passes partial mode — the sweep is empty-only (§18.9)');
    }
    if (!p6Failed) {
        console.log(
            `check-diagnostics: Phase 6 partial-data pins clean (§18.8a — ${literals.size} verdict ids classified, ${neutral.size} neutral placeholders)`,
        );
    }
}

// --- 3k: the §19 evidence-refinement pins (build 319) -----------------------
//
// (1) WRITER pins against the Data TA source (the L11 discipline): the stamp
//     parser expects `[logserv_set_cloud_provider]` + `FORMAT =
//     cloud_provider::<v>` from rh_filter_settings.py, and the transforms
//     inverse (session 154, design s154 §5a) expects the generated REGEX to
//     be built from filter_utils.py's FILTER_REGEX_SKIP + FILTER_REGEX_GAP
//     with lookaheads on the `clz_dir` / `clz_subdir` / `source` keys. The
//     two constants are pinned by their DECODED value (what the Python string
//     literal evaluates to) against the contract below AND against the App's
//     own TA_FILTER_REGEX_SKIP / TA_FILTER_REGEX_GAP, which the inverse
//     parses with; the rest of the generated text (fragment map, key
//     separator and order, chunk join / tail / naming, stanza names and
//     layout, the time REGEX) is pinned by the generator's source text. A
//     writer-mechanism change must fail HERE, not in a customer's mis-parsed
//     paste. LOGSERV_TA_FILTER_UTILS_PY overrides the filter_utils.py path
//     for the gate's control runs. Session 154 round 2 (design s154 §5b, the
//     linear '*' translation): the star-run split, the atomic middle-segment
//     template `(?>[^"]*?` + seg + `)` and the order seg(S0), groups,
//     `[^"]*`, seg(Sk) are pinned as source text, and the four value
//     literals (the group's open and close, `[^"]*`, `[^"]`) are read out of
//     that text and compared with the contract AND with the App's
//     TA_FILTER_FRAG_* constants the inverse reads them with. Round 3
//     (verify_report_r2.md F1): the WHOLE `_star_segments` body is pinned
//     line by line - its start, the split and the in-order return - with
//     exactly one definition, no decorator and no other binding of the name.
// (2) The H19 rider: createMemoizingRunner must FORWARD the per-probe
//     maxTimeSeconds 4th argument and key the memo on it.
// (3) The drawer renders the §19.5 pointer through the shared predicate and
//     carries the same sentence in Copy-technical-summary (§19.8a-19).
{
    let s19Failed = false;
    const s19fail = (m) => {
        s19Failed = true;
        failed = true;
        console.error(`check-diagnostics: ${m}`);
    };
    const HOME19 = path.resolve(__dirname, '../src/main/webapp/pages/home');

    // (1) the Data TA writer literals.
    const RH_PATH = path.resolve(
        __dirname,
        '../../../../splunk_ta_sap_logserv/package/bin/splunk_ta_sap_logserv_rh_filter_settings.py',
    );
    const UTILS_PATH = process.env.LOGSERV_TA_FILTER_UTILS_PY || path.resolve(
        __dirname,
        '../../../../splunk_ta_sap_logserv/package/bin/splunk_ta_sap_logserv_filter_utils.py',
    );
    if (!fs.existsSync(RH_PATH) || !fs.existsSync(UTILS_PATH)) {
        s19fail(
            'the Data TA source sibling is missing — the §19 writer pins derive from ' +
                RH_PATH +
                ' and ' +
                UTILS_PATH,
        );
    } else {
        const rhSrc = fs.readFileSync(RH_PATH, 'utf8');
        if (rhSrc.indexOf('[logserv_set_cloud_provider]') === -1 || rhSrc.indexOf('FORMAT = cloud_provider::') === -1) {
            s19fail(
                'the Data TA cloud-provider writer no longer emits the [logserv_set_cloud_provider] / FORMAT = cloud_provider:: shape the §19.4 stamp parser expects',
            );
        }
        const utilsSrc = fs.readFileSync(UTILS_PATH, 'utf8');
        const REVERIFY =
            " — the Data Doctor's transforms inverse (utils/diagIngestFacts.ts) must be re-verified against the generator";
        // The contract (design s154 §5a), as regex TEXT:
        //   FILTER_REGEX_SKIP = (?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")
        //   FILTER_REGEX_GAP  = (?:(?!"_raw")[^\n])*?
        const CONTRACT_SKIP = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")`;
        const CONTRACT_GAP = String.raw`(?:(?!"_raw")[^\n])*?`;
        const BS19 = String.fromCharCode(92);
        // Decode a one-line Python string constant `NAME = r'...'` (or a
        // non-raw '...' / "..." literal) to the value Python evaluates.
        const pyStringConst = (src, name) => {
            const line = src.split(/\r?\n/).find((l) => l.indexOf(name) === 0 && /^[A-Z_]+\s*=/.test(l) && l.split('=')[0].trim() === name);
            if (!line) return { error: `filter_utils.py defines no module-level ${name}` };
            const rest = line.slice(line.indexOf('=') + 1).trim();
            const pm = /^([rRuU]?)(['"])/.exec(rest);
            if (!pm || rest.slice(pm[1].length, pm[1].length + 3) === pm[2].repeat(3)) {
                return { error: `${name} in filter_utils.py is not a one-line string literal` };
            }
            const raw = pm[1] === 'r' || pm[1] === 'R';
            const q = pm[2];
            const esc = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"' };
            esc[BS19] = BS19;
            let i = pm[0].length;
            let out = '';
            for (;;) {
                if (i >= rest.length) return { error: `${name} in filter_utils.py is an unterminated string literal` };
                const ch = rest[i];
                if (ch === q) {
                    i += 1;
                    break;
                }
                if (ch === BS19) {
                    const c = rest[i + 1];
                    if (c === undefined) return { error: `${name} in filter_utils.py ends in a lone backslash` };
                    // raw: backslash and the next character both stay; non-raw:
                    // the known escapes decode, unknown ones stay as written
                    out += !raw && Object.prototype.hasOwnProperty.call(esc, c) ? esc[c] : ch + c;
                    i += 2;
                    continue;
                }
                out += ch;
                i += 1;
            }
            const tail = rest.slice(i).trim();
            if (tail !== '' && tail[0] !== '#') {
                return { error: `${name} in filter_utils.py is not a single string literal (continues with "${tail.slice(0, 40)}")` };
            }
            return { value: out };
        };
        const ingest19 = loadTs(path.join(UTILS, 'diagIngestFacts'));
        for (const [pyName, contract, appName] of [
            ['FILTER_REGEX_SKIP', CONTRACT_SKIP, 'TA_FILTER_REGEX_SKIP'],
            ['FILTER_REGEX_GAP', CONTRACT_GAP, 'TA_FILTER_REGEX_GAP'],
        ]) {
            const got = pyStringConst(utilsSrc, pyName);
            if (got.error) {
                s19fail(`${got.error}${REVERIFY}`);
            } else if (got.value !== contract) {
                s19fail(
                    `filter_utils.py ${pyName} decodes to ${JSON.stringify(got.value)}, not the contracted ${JSON.stringify(contract)}${REVERIFY}`,
                );
            }
            if (ingest19[appName] !== contract) {
                s19fail(
                    `diagIngestFacts.ts ${appName} is ${JSON.stringify(ingest19[appName])}, not the contracted ${JSON.stringify(contract)}${REVERIFY}`,
                );
            }
        }
        for (const key of ['clz_dir', 'clz_subdir', 'source']) {
            if (utilsSrc.indexOf(`'${key}'`) === -1 && utilsSrc.indexOf(`"${key}"`) === -1) {
                s19fail(`filter_utils.py no longer names the "${key}" key the generated lookaheads match${REVERIFY}`);
            }
        }
        // The rest of the generated text the inverse depends on (session 154
        // review): the value-fragment map, the lookahead's key separator, the
        // folder / source / combined key order, the chunk join and tail, the
        // chunk stanza naming, the six stanza names, the stanza layout and the
        // time REGEX. Pinned as the generator's SOURCE TEXT (Python source,
        // so a backslash pair below is what the .py file holds); any change
        // to one of them must fail here, not in a customer's paste.
        const S19_TEXT_PINS = [
            ['the * fragment (design 5b: only before the last segment)', String.raw`out.append('[^"]*')`],
            ['the ? fragment', String.raw`out.append('[^"]')`],
            [
                'the atomic middle-segment template (design 5b)',
                String.raw`out.append('(?>[^"]*?' + _fragment_segment(middle, pattern) + ')')`,
            ],
            ['the middle segments (design 5b: S1 .. S(k-1) only)', 'for middle in segments[1:-1]:'],
            ['the word characters kept as they are', "'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'"],
            ['the escaped characters', "_FRAGMENT_ESCAPED_CHARS = frozenset('/.-:+@~')"],
            ['the escape emission', String.raw`out.append('\\' + ch)`],
            ['the lookahead keys', "_LOOKAHEAD_KEYS = ('clz_dir', 'clz_subdir', 'source')"],
            ['the lookahead text', String.raw`return '(?=' + FILTER_REGEX_GAP + '"' + key + '"\\s*:\\s*"' + fragment + '")'`],
            ['the chunk head', "head = FILTER_REGEX_SKIP + '(?:'"],
            ['the chunk tail', "tail = ')'"],
            ['the chunk join', "return [head + '|'.join(chunk) + tail for chunk in chunks]"],
            ['the chunk numbering', 'enumerate(_chunk_regexes(alternatives, field_name), 1)'],
            ['the chunk stanza naming', "name if number == 1 else f'{name}_{number}'"],
            ['the include-drop stanza', "plan.append(('logserv_filter_include_drop', '.', 'nullQueue'))"],
            ['the include-allow stanza', "add_chunks('logserv_filter_include_allow',"],
            ['the include-sources stanza', "add_chunks('logserv_filter_include_sources',"],
            ['the time-drop stanza', "plan.append(('logserv_filter_time_drop', full_regex, 'nullQueue'))"],
            ['the exclude stanza', "add_chunks('logserv_filter_exclude',"],
            ['the exclude-sources stanza', "add_chunks('logserv_filter_exclude_sources',"],
            ['the stanza header line', String.raw`f'[{name}]\n'`],
            ['the REGEX line', String.raw`f'REGEX = {regex}\n'`],
            ['the time REGEX', String.raw`full_regex = f'"_time"\\s*:\\s*"?(?:{epoch_regex})(?:\\.\\d+)?'`],
        ];
        for (const [what, text] of S19_TEXT_PINS) {
            const n = utilsSrc.split(text).length - 1;
            if (n !== 1) {
                s19fail(
                    `filter_utils.py holds ${n} copies of ${what} (expected exactly 1: ${JSON.stringify(text)})${REVERIFY}`,
                );
            }
        }
        // Key ORDER inside an entry: clz_dir before clz_subdir in a folder,
        // the folder before the source in a combined entry.
        const S19_ORDER_PINS = [
            [
                'the folder lookahead order (clz_dir, then clz_subdir)',
                /return \(filter_lookahead\('clz_dir', filter_pattern_fragment\(dir_part\)\)\s*\+ filter_lookahead\('clz_subdir', filter_pattern_fragment\(subdir_part\)\)\)/,
            ],
            [
                'the combined entry order (folder, then source)',
                /return \(_folder_alternative\(folder\)\s*\+ filter_lookahead\('source', filter_pattern_fragment\(pattern\)\)\)/,
            ],
            ['the plain source entry', /return filter_lookahead\('source', filter_pattern_fragment\(entry\)\)/],
        ];
        for (const [what, re] of S19_ORDER_PINS) {
            if (!re.test(utilsSrc)) {
                s19fail(`filter_utils.py no longer writes ${what} as the inverse expects${REVERIFY}`);
            }
        }
        // Design 5b: the WHOLE _star_segments body, line by line with its
        // indentation (session 154 round 3, verify_report_r2.md F1: the split
        // loop alone was pinned, and three mutants of the start and the return
        // passed - segments = [[], []] put a [^"]* before every pattern). The
        // docstring may change but holds no backslash (so its first """ ends
        // it), and nothing follows the return inside the function. The name
        // has exactly one definition, no decorator, and every other mention is
        // a call or a docstring reference, so nothing rebinds it.
        const S19_STAR_SEGMENTS =
            /(?:^|\n)def _star_segments\(pattern\):\r?\n {4}"""(?:(?!""")[^\\])*"""\r?\n {4}segments = \[\[\]\]\r?\n {4}in_run = False\r?\n {4}for ch in pattern:\r?\n {8}if ch == '\*':\r?\n {12}if not in_run:\r?\n {16}segments\.append\(\[\]\)\r?\n {12}in_run = True\r?\n {8}else:\r?\n {12}segments\[-1\]\.append\(ch\)\r?\n {12}in_run = False\r?\n {4}return \[''\.join\(segment\) for segment in segments\]\r?\n(?:[ \t]*\r?\n)*(?=\S|(?![\s\S]))/;
        const starM = S19_STAR_SEGMENTS.exec(utilsSrc);
        if (!starM) {
            s19fail(
                `filter_utils.py no longer defines _star_segments exactly as the inverse expects (design 5b: segments = [[]] and in_run = False at the start, a run of * is ONE *, the segments returned in order, nothing after the return; the docstring may change but must hold no backslash)${REVERIFY}`,
            );
        } else {
            // The statement before the def: walk back over blank and comment
            // lines, closing-bracket lines and indented (continuation or
            // body) lines to the previous column-0 statement; it must not be
            // a decorator.
            const before = utilsSrc.slice(0, starM.index + starM[0].indexOf('def _star_segments')).split(/\r?\n/);
            let prev = '';
            for (let i = before.length - 1; i >= 0; i--) {
                const line = before[i];
                const t = line.trim();
                if (t === '' || t.startsWith('#') || /^[)\]}]/.test(t) || /^[ \t]/.test(line)) {
                    continue;
                }
                prev = t;
                break;
            }
            if (prev.startsWith('@')) {
                s19fail(`filter_utils.py decorates _star_segments (${JSON.stringify(prev)}), so the pinned body is not what runs${REVERIFY}`);
            }
        }
        const starDefs = (utilsSrc.match(/^[ \t]*(?:(?:async[ \t]+)?def|class)[ \t]+_star_segments\b/gm) || []).length;
        if (starDefs !== 1) {
            s19fail(`filter_utils.py defines _star_segments ${starDefs} times (expected exactly 1, the pinned one)${REVERIFY}`);
        }
        // Full-line comments may name it freely; anywhere else the name must
        // be followed by ( (a call or its def) or a backtick (a docstring
        // reference such as :func:`_star_segments`).
        const starOther = (utilsSrc.replace(/^[ \t]*#[^\r\n]*/gm, '').match(/\b_star_segments\b(?![(`])/g) || []).length;
        if (starOther !== 0) {
            s19fail(`filter_utils.py mentions _star_segments ${starOther} time(s) other than as a call, its def, a backticked docstring reference or in a full-line comment, so something may rebind it${REVERIFY}`);
        }
        // Design 5b: the whole linear translation in order - seg(S0), one
        // atomic group per MIDDLE segment, [^"]*, seg(Sk) - with its value
        // literals captured (single-quoted, no backslash: the source text IS
        // the value) and held against the contract and the App's constants.
        const S19_LINEAR =
            /segments = _star_segments\(pattern\)\s*if len\(segments\) == 1:\s*return _fragment_segment\(pattern, pattern\)\s*out = \[_fragment_segment\(segments\[0\], pattern\)\]\s*for middle in segments\[1:-1\]:\s*out\.append\('([^'\\\r\n]*)' \+ _fragment_segment\(middle, pattern\) \+ '([^'\\\r\n]*)'\)\s*out\.append\('([^'\\\r\n]*)'\)\s*out\.append\(_fragment_segment\(segments\[-1\], pattern\)\)\s*return ''\.join\(out\)/;
        const S19_ONE = /if ch == '\?':\s*out\.append\('([^'\\\r\n]*)'\)/;
        const linM = S19_LINEAR.exec(utilsSrc);
        const oneM = S19_ONE.exec(utilsSrc);
        if (!linM) {
            s19fail(`filter_utils.py no longer writes the linear * translation (seg(S0), (?>[^"]*?SEG) per middle segment, [^"]*, seg(Sk)) as the inverse expects${REVERIFY}`);
        }
        if (!oneM) {
            s19fail(`filter_utils.py no longer writes the ? fragment as one literal the gate can read${REVERIFY}`);
        }
        for (const [what, got, contract, appName] of [
            ['the atomic group open', linM && linM[1], '(?>[^"]*?', 'TA_FILTER_FRAG_ATOM_OPEN'],
            ['the atomic group close', linM && linM[2], ')', 'TA_FILTER_FRAG_ATOM_CLOSE'],
            ['the last-segment * fragment', linM && linM[3], '[^"]*', 'TA_FILTER_FRAG_STAR'],
            ['the ? fragment', oneM && oneM[1], '[^"]', 'TA_FILTER_FRAG_ONE'],
        ]) {
            // got is null when the text above was not found (already reported)
            if (got !== null && got !== contract) {
                s19fail(`filter_utils.py writes ${what} as ${JSON.stringify(got)}, not the contracted ${JSON.stringify(contract)}${REVERIFY}`);
            }
            if (ingest19[appName] !== contract) {
                s19fail(`diagIngestFacts.ts ${appName} is ${JSON.stringify(ingest19[appName])}, not the contracted ${JSON.stringify(contract)} (${what})${REVERIFY}`);
            }
        }
    }

    // (2) the memoizing runner forwards + keys maxTimeSeconds (H19).
    const sweepMod = loadTs(path.join(UTILS, 'diagSweep'));
    const calls = [];
    const inner = {
        search: (spl, e, l, cap) => {
            calls.push({ spl, cap });
            return Promise.resolve({ rows: [], error: '', durationMs: 1, skipped: false });
        },
        kv: () => Promise.resolve({ rows: [], error: '', durationMs: 1, skipped: false }),
        rest: () => Promise.resolve({ rows: [], error: '', durationMs: 1, skipped: false }),
        cancel: () => undefined,
        isCancelled: () => false,
        elapsedMs: () => 0,
        remainingMs: () => 60000,
        dispatched: () => 0,
    };
    const memo = sweepMod.createMemoizingRunner(inner);
    memo.search('| makeresults', '-1m', 'now', 20);
    memo.search('| makeresults', '-1m', 'now', 20); // identical: shares
    memo.search('| makeresults', '-1m', 'now'); // no cap: distinct dispatch
    memo.search('| makeresults', '-1m', 'now', 15); // different cap: distinct
    if (calls.length !== 3) {
        s19fail(`createMemoizingRunner memo-keying on maxTimeSeconds broke: expected 3 inner dispatches, got ${calls.length} (H19)`);
    } else if (calls[0].cap !== 20 || calls[1].cap !== undefined || calls[2].cap !== 15) {
        s19fail(`createMemoizingRunner drops the per-probe maxTimeSeconds: got caps ${JSON.stringify(calls.map((c) => c.cap))} (H19)`);
    }

    // (3) the drawer pointer + Copy-summary ride the shared predicate.
    const drawerSrc19 = fs.readFileSync(path.join(HOME19, 'state/DiagnosticDrawerProvider.tsx'), 'utf8');
    const ptrRenders = (drawerSrc19.match(/shouldShowIngestPointer\(/g) || []).length;
    if (ptrRenders < 2) {
        s19fail(
            `the drawer must consult shouldShowIngestPointer for BOTH the rendered pointer and Copy-technical-summary — found ${ptrRenders} call(s) (§19.8a-19)`,
        );
    }
    if (drawerSrc19.indexOf('INGEST_POINTER_SENTENCE') === -1) {
        s19fail('the drawer no longer renders INGEST_POINTER_SENTENCE (§19.5)');
    }

    if (!s19Failed) {
        console.log('check-diagnostics: §19 evidence-refinement pins clean (writer literals + H19 forward + pointer)');
    }
}

// --- 3l: the §20 rollup-SPL surfacing + full-length-samples pins ------------
//
// §20.8a items 2/11/12/13 + the drawer surfaces. The backfill-identity check
// DERIVES the §20 hedge's premise from the shipped conf every build: if a
// backfill's `search =` ever diverges from its aggregate's, the wording "As
// shipped, the backfill stanza carries the same search text" becomes false
// and this fails the build instead of shipping the false claim.
{
    let s20Failed = false;
    const s20fail = (m) => {
        s20Failed = true;
        failed = true;
        console.error(`check-diagnostics: ${m}`);
    };
    const HOME20 = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const UTILS20 = path.join(HOME20, 'utils');

    // (1) §20.5-1/§20.8a-12 — backfill identity, registry-driven (the
    // platform aggregate has no backfill BY DESIGN and is naturally exempt:
    // it is not a registry rollup). Sibling by NAME TRANSFORM, never index
    // alignment; compare ONLY the `search =` values (stanza bodies differ by
    // design: dispatch windows, cron, disabled). Backslash continuations are
    // collapsed identically on both sides before comparison.
    const confPath20 = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );
    const confRaw20 = fs.readFileSync(confPath20, 'utf8').replace(/\\\r?\n/g, ' ');
    const stanzaSearch20 = {};
    confRaw20.split(/^\[/m).forEach((chunk) => {
        const nm = chunk.match(/^([^\]]+)\]/);
        if (!nm) return;
        const sm = chunk.match(/^search\s*=\s*(.*)$/m);
        if (sm) stanzaSearch20[nm[1]] = sm[1];
    });
    const registry20 = loadTs(path.join(HOME20, 'routes/rollupRegistry'));
    const evidenceMod20 = loadTs(path.join(UTILS20, 'diagEvidence'));
    const backfillNameFor20 = evidenceMod20.backfillNameFor;
    if (typeof backfillNameFor20 !== 'function') {
        s20fail('diagEvidence no longer exports backfillNameFor (§20.8a-2)');
    } else {
        registry20.ROLLUPS.forEach((def) => {
            if (def.aggregateSearches.length !== def.backfillStanzas.length) {
                s20fail(
                    `rollup '${def.key}': ${def.aggregateSearches.length} aggregate(s) vs ${def.backfillStanzas.length} backfill stanza(s) — the §20 pairing premise needs equal sets (§20.8a-12)`,
                );
            }
            def.aggregateSearches.forEach((agg) => {
                const bf = backfillNameFor20(agg);
                if (def.backfillStanzas.indexOf(bf) === -1) {
                    s20fail(
                        `aggregate '${agg}': the derived sibling '${bf}' is not among the rollup's registered backfill stanzas (§20.8a-12 name transform)`,
                    );
                    return;
                }
                if (!stanzaSearch20[agg]) {
                    s20fail(`aggregate '${agg}' has no search= in the shipped conf`);
                    return;
                }
                if (!stanzaSearch20[bf]) {
                    s20fail(`backfill '${bf}' has no search= in the shipped conf`);
                    return;
                }
                if (stanzaSearch20[agg] !== stanzaSearch20[bf]) {
                    s20fail(
                        `§20.8a-2 identity premise broken: '${agg}' and '${bf}' carry DIFFERENT search= values in the shipped conf — the as-shipped hedge wording is now false; §20 must render both texts instead`,
                    );
                }
            });
        });
    }

    // (2) §20.8a-11 — worst-case stored-model growth, derived from the
    // artifact: (sum of the FETCH_MAX largest aggregate search= values) × 2
    // stored copies + 60 K base headroom must stay under the persistence
    // truncation threshold, or a legitimate dashboard report stores as a
    // non-re-downloadable stub.
    const persistMod20 = loadTs(path.join(UTILS20, 'diagPersistence'));
    const maxModel20 = persistMod20.MAX_MODEL_JSON_CHARS;
    const fetchMax20 = evidenceMod20.PRODUCER_SPL_FETCH_MAX;
    if (typeof maxModel20 !== 'number' || typeof fetchMax20 !== 'number') {
        s20fail('MAX_MODEL_JSON_CHARS / PRODUCER_SPL_FETCH_MAX are no longer exported');
    } else {
        const aggNames20 = [].concat(...registry20.ROLLUPS.map((d) => d.aggregateSearches));
        const lens20 = aggNames20
            .map((n) => (stanzaSearch20[n] || '').length)
            .sort((a, b) => b - a)
            .slice(0, fetchMax20);
        const worst20 = 2 * lens20.reduce((a, b) => a + b, 0) + 60_000;
        if (worst20 >= maxModel20) {
            s20fail(
                `§20.8a-11 size bound broken: top-${fetchMax20} aggregates × 2 copies + 60K base = ${worst20} >= MAX_MODEL_JSON_CHARS (${maxModel20})`,
            );
        }
    }

    // (3) §20.8a-13 — the sample ceiling never exceeds the PDF mono cap (the
    // collector's disclosed marker must be the one the reader sees). The PDF
    // module imports jspdf, so its constant is read from SOURCE.
    const sampleCap20 = evidenceMod20.RAW_SAMPLE_EVENT_MAX_CHARS;
    const pdfSrc20 = fs.readFileSync(path.join(UTILS20, 'diagReportPdf.ts'), 'utf8');
    const monoM20 = pdfSrc20.match(/MONO_BLOCK_MAX_CHARS = ([\d_]+)/);
    if (typeof sampleCap20 !== 'number' || !monoM20) {
        s20fail('RAW_SAMPLE_EVENT_MAX_CHARS / MONO_BLOCK_MAX_CHARS are missing (§20.8a-13)');
    } else {
        const monoCap20 = parseInt(monoM20[1].replace(/_/g, ''), 10);
        if (!(sampleCap20 <= monoCap20)) {
            s20fail(
                `RAW_SAMPLE_EVENT_MAX_CHARS (${sampleCap20}) exceeds the PDF mono cap (${monoCap20}) — the renderer's marker would override the collector's (§20.8a-13)`,
            );
        }
    }

    // (4) the drawer surfaces: producerSpl in BOTH the technical-detail
    // render and buildSummary; the shared intro; no stale 500-char claim.
    const drawerSrc20 = fs.readFileSync(
        path.join(HOME20, 'state/DiagnosticDrawerProvider.tsx'),
        'utf8',
    );
    const producerRefs20 = (drawerSrc20.match(/producerSpl/g) || []).length;
    if (producerRefs20 < 2) {
        s20fail(
            `the drawer must consume producerSpl in BOTH the technical detail and Copy-technical-summary — found ${producerRefs20} reference(s) (§20.2)`,
        );
    }
    if (drawerSrc20.indexOf('PRODUCER_SPL_INTRO') === -1) {
        s20fail('the drawer lost the §20.8a-7 not-executed intro');
    }
    if (/truncated to 500/.test(drawerSrc20)) {
        s20fail('the drawer still claims the retired 500-char truncation (§20.4)');
    }

    // (5) session 113 — the drawer's per-entry "Open in Search" action must
    //     route through producerSplForOpenInSearch, which strips the terminal
    //     `| outputlookup` write (opened verbatim, one Enter press over a
    //     partial window upserts partial rows over correct summary rows —
    //     the drawer's no-destructive-controls rule). DERIVED, not restated:
    //     the strip must succeed on EVERY registry aggregate's shipped
    //     search=, so a future aggregate whose shape the strip cannot handle
    //     fails HERE instead of silently hiding (or worse, arming) the
    //     button on that entry.
    const reportMod113 = loadTs(path.join(UTILS20, 'diagReport'));
    if (typeof reportMod113.producerSplForOpenInSearch !== 'function') {
        s20fail('diagReport no longer exports producerSplForOpenInSearch (session 113)');
    } else {
        const aggNames113 = [].concat(...registry20.ROLLUPS.map((d) => d.aggregateSearches));
        aggNames113.forEach((n) => {
            const spl = stanzaSearch20[n];
            if (!spl) return; // already reported by (1)
            const opened = reportMod113.producerSplForOpenInSearch(spl);
            if (opened === null) {
                s20fail(
                    `aggregate '${n}': producerSplForOpenInSearch refuses its shipped search= — the Open-in-Search button would be silently hidden for this entry (session 113)`,
                );
            } else if (/\boutputlookup\b/i.test(opened)) {
                s20fail(
                    `aggregate '${n}': the opened SPL still contains outputlookup — the write was not removed (session 113)`,
                );
            }
        });
    }
    if (drawerSrc20.indexOf('producerSplForOpenInSearch') === -1) {
        s20fail('the drawer no longer routes Open-in-Search through producerSplForOpenInSearch (session 113)');
    }
    // Both bypass shapes: `buildOpenInSearchUrl(p.spl…)` at the map site AND
    // `buildOpenInSearchUrl(spl…)` inside the block component. The stripped
    // value is deliberately named `openable` so a verbatim pass-through is
    // regex-distinguishable.
    if (/buildOpenInSearchUrl\(\s*(p\.)?spl\b/.test(drawerSrc20)) {
        s20fail(
            'the drawer passes a producer definition VERBATIM to buildOpenInSearchUrl — the outputlookup write would ship in the URL (session 113)',
        );
    }

    if (!s20Failed) {
        console.log(
            'check-diagnostics: §20 pins clean (backfill identity derived from the conf + size bound + cap relation + drawer surfaces + the open-in-search strip over every shipped aggregate)',
        );
    }
}

// --- 3m: the topology EDGE ID contract, derived from the shipped conf -------
//
// The Edge Details tabs read the rollup by the STORED edge id. That id is
// hand-duplicated across FOUR stanzas: [logserv_topology_aggregate_edges] and
// its backfill twin produce it once over the union's `type` field as
// `logserv_topology_edges.id`, while [logserv_topology_detail_aggregate] and
// ITS twin re-derive the identical expression three times per edge type
// (edge_op/edge_perf/edge_err; 15 for the five types of build 378) as those
// metrics' `scope`. Nothing but this check
// couples them, and the failure mode of a drift is zero rows -- which is
// indistinguishable from the build-240 regression this change exists to end.
//
// Everything below is DERIVED from the conf: the substr length feeds the
// shipped sanitizer, so hard-coding it in either place fails the build.
{
    const SAVEDSEARCHES = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );
    const conf = fs.readFileSync(SAVEDSEARCHES, 'utf8');
    const stanzas = {};
    let current = null;
    for (const raw of conf.split('\n')) {
        const m = /^\[(.+)\]\s*$/.exec(raw.trim());
        if (m) {
            current = m[1];
            stanzas[current] = [];
        } else if (current) {
            stanzas[current].push(raw);
        }
    }

    const EDGE_STANZAS = ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'];
    const DETAIL_STANZAS = ['logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill'];
    const missing = EDGE_STANZAS.concat(DETAIL_STANZAS).filter((n) => !stanzas[n]);
    if (missing.length > 0) {
        console.error(`check-diagnostics: missing topology stanza(s): ${missing.join(', ')}`);
        failed = true;
    } else {
        // Two spellings of one expression: the edges stanzas concatenate the
        // union's `type` field, the detail arms bake the type into the literal.
        const bodyOf = (n) => stanzas[n].join('\n');
        const readIds = (body) => {
            const out = [];
            const re = /substr\(sha1\(source_id \. ":" \. target_id \. (?:":" \. type|":(\w+)")\), 1, (\d+)\)/g;
            let m;
            while ((m = re.exec(body)) !== null) out.push({ type: m[1] || '<field>', len: Number(m[2]) });
            return out;
        };
        const edgeIds = EDGE_STANZAS.map((n) => readIds(bodyOf(n)));
        const detailIds = DETAIL_STANZAS.map((n) => readIds(bodyOf(n)));

        // The type set the edges stanza emits: EVERY lower-case `type="..."`
        // literal (build 378: the hard-coded list of four hid a fifth type,
        // saprouter, from the check), so a new type cannot pass unseen.
        const evalTypes = (body) => {
            const out = new Set();
            const re = /\btype\s*=\s*"([a-z_]+)"/g;
            let m;
            while ((m = re.exec(body)) !== null) out.add(m[1]);
            return Array.from(out).sort();
        };
        const edgeTypes = evalTypes(bodyOf(EDGE_STANZAS[0]));

        // (a) shape: one shared derivation per edges stanza, three per edge type
        //     per detail stanza (edge_op / edge_perf / edge_err). A count change
        //     means an edge type was added on one side.
        edgeIds.forEach((ids, i) => {
            if (ids.length !== 1) {
                console.error(
                    `check-diagnostics: [${EDGE_STANZAS[i]}] has ${ids.length} edge-id derivations, expected 1`,
                );
                failed = true;
            }
        });
        detailIds.forEach((ids, i) => {
            if (ids.length !== edgeTypes.length * 3) {
                console.error(
                    `check-diagnostics: [${DETAIL_STANZAS[i]}] has ${ids.length} edge-scope derivations, expected `
                    + `${edgeTypes.length * 3} (${edgeTypes.length} types x 3 metrics)`,
                );
                failed = true;
            }
            edgeTypes.forEach((t) => {
                const k = ids.filter((x) => x.type === t).length;
                if (k !== 3) {
                    console.error(`check-diagnostics: [${DETAIL_STANZAS[i]}] scopes type ${t} ${k} time(s), expected 3`);
                    failed = true;
                }
            });
        });

        // (b) the type SETS must agree: whatever `eval type="..."` the edges
        //     stanza emits is exactly what the detail arms may scope by.
        DETAIL_STANZAS.forEach((n, i) => {
            const seen = Array.from(new Set(detailIds[i].map((x) => x.type))).sort();
            if (JSON.stringify(seen) !== JSON.stringify(edgeTypes)) {
                console.error(
                    `check-diagnostics: [${n}] scopes ${JSON.stringify(seen)} but the edges stanza emits ${JSON.stringify(edgeTypes)}`,
                );
                failed = true;
            }
        });

        // (c) one length everywhere, on both sides.
        const lens = Array.from(new Set(
            [].concat.apply([], edgeIds.concat(detailIds)).map((x) => x.len),
        ));
        if (lens.length !== 1) {
            console.error(`check-diagnostics: edge id substr lengths disagree across stanzas: ${lens.join(', ')}`);
            failed = true;
        }

        // (d) aggregate and backfill must agree, pairwise.
        if (JSON.stringify(edgeIds[0]) !== JSON.stringify(edgeIds[1])) {
            console.error('check-diagnostics: topology edges aggregate/backfill id derivations differ');
            failed = true;
        }
        if (JSON.stringify(detailIds[0]) !== JSON.stringify(detailIds[1])) {
            console.error('check-diagnostics: topology detail aggregate/backfill scope derivations differ');
            failed = true;
        }

        // (e) feed the conf-derived length into the shipped sanitizer. This is
        //     the coupling that matters: the UI may only accept the id shape
        //     the conf actually writes, and must refuse the display id.
        if (lens.length === 1) {
            const N = lens[0];
            const edgeIdsMod = loadTs(path.resolve(__dirname, '../src/main/webapp/pages/home/topology/edgeIds'));
            if (edgeIdsMod.EDGE_ID_HEX_LEN !== N) {
                console.error(
                    `check-diagnostics: EDGE_ID_HEX_LEN is ${edgeIdsMod.EDGE_ID_HEX_LEN} but the conf writes substr(..., 1, ${N})`,
                );
                failed = true;
            }
            const sample = 'a1b2c3d4e5f60789'.repeat(4).slice(0, N);
            if (edgeIdsMod.sanitizeEdgeIds([sample]) === null) {
                console.error(`check-diagnostics: the sanitizer rejects a ${N}-char id the conf actually writes`);
                failed = true;
            }
            if (edgeIdsMod.sanitizeEdgeIds([`${sample}0`]) !== null) {
                console.error('check-diagnostics: the sanitizer accepts an over-length id');
                failed = true;
            }
            const display = edgeIdsMod.edgeDisplayId(sample, sample, edgeTypes[0] || 'http');
            if (edgeIdsMod.sanitizeEdgeIds([display]) !== null) {
                console.error('check-diagnostics: the sanitizer accepts the composite DISPLAY id (the build-240 bug)');
                failed = true;
            }
            console.log(
                `check-diagnostics: topology edge-id contract derived from conf (substr len ${N}, types ${edgeTypes.join('/')}, ${detailIds[0].length} detail arms x2)`,
            );
        }
    }
}

// --- 3m2: source pins for the two call sites that carry the edge id --------
//
// The behavioural test cannot see WHICH value the hook hands the builders, and
// that substitution is the whole bug. Also pinned: the node-scope / edge-scope
// asymmetry (nodes key on the canonical LABEL, edges on stored ids -- a future
// "cleanup" unifying the two sanitizers breaks one side silently).
{
    const H = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const src = (rel) => fs.readFileSync(path.join(H, rel), 'utf8');
    const pin = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: ${label}: ${detail}`);
            failed = true;
        }
    };

    const edgeData = src('hooks/useEdgeData.ts');
    pin('useEdgeData no longer sanitizes bucketIds',
        edgeData.indexOf('sanitizeEdgeIds(edge?.bucketIds)') > 0,
        'the bucketIds -> sanitizer wiring is gone');
    pin('useEdgeData passes the display id to a builder again (the build-240 bug)',
        edgeData.indexOf('edge?.id') === -1 && !/SEARCH_EDGE_\w+\([^)]*\bedgeId\b\s*\)/.test(edgeData),
        'edge.id reached a builder');
    pin('useEdgeData stopped reporting whether it dispatched',
        edgeData.indexOf('dispatched: true') > 0 && edgeData.indexOf('dispatched: false') > 0,
        'the dispatched flag is gone, so the pane can assert an absence it never measured');

    const topo = src('hooks/useTopologyData.ts');
    pin('useTopologyData no longer emits bucketIds from the collector',
        topo.indexOf('bucketIds: collectBucketIds(agg.rows)') > 0, 'the emit site changed');
    pin('the edge group key no longer includes the type',
        /edgeDisplayId\(\s*retargetedSource,\s*retargetedTarget,\s*row\.type\s*\)/.test(topo),
        'two edge types could merge into one rendered edge and share a histogram');

    const integ = src('dashboards/IntegrationTopology.tsx');
    pin('nodes are no longer scoped by their canonical LABEL',
        /useNodeData\(\s*selectedNodeLabel/.test(integ), 'the node scope changed');
    pin('edges are no longer scoped by the edge OBJECT',
        /useEdgeData\(\s*selectedEdge/.test(integ), 'the edge scope changed');

    const searches = src('topology/searches.ts');
    pin('a dispatched SEARCH_EDGE_ACTIVITY came back',
        !/export const SEARCH_EDGE_ACTIVITY/.test(searches),
        'the Activity series must stay in-memory so it decomposes callCount exactly');

    console.log('check-diagnostics: topology edge-id call sites pinned (bucketIds in, display id out)');
}

// --- 3p: the build-325 topology conf contract (seed / rfc key / instances) --
//
// Three conf-side properties of the session-110 refactor (plan items A3, E1,
// D2), each with a webapp counterpart that silently degrades if the conf
// drifts:
//
//  (a) the NODES stanzas emit NO "sid_focused" — High/Regular Traffic is
//      render-time top-10 over SIDs only (computeHighTrafficNodeIds). A
//      restored seed would not break the render (the memo recomputes kind in
//      both directions) but would ship a dead hard-coded estate assumption
//      back into every customer's KV rows.
//  (b) the RFC row key is metric-scoped with the LEGACY FORM BYTE-IDENTICAL
//      as the fallback. Any other fallback re-keys http/hana_audit/
//      hana_tenant history so the next hourly upsert double-counts; losing
//      the rfc branch restores the session-107 per-app-server collision
//      (last-write-wins, a silent undercount).
//  (c) both node_host arms carry `values(sap_inst) as instances`, and the
//      new fields survive BOTH the SPL projection and the transforms.conf
//      fields_list — outputlookup silently DROPS fields absent from
//      fields_list, so a drift there turns the Hosts tab's instance line
//      (and the By-app-server table's addresses) off with no error anywhere.
{
    const DEFAULT_DIR = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const readConf = (name) => fs.readFileSync(path.join(DEFAULT_DIR, name), 'utf8');
    const parseStanzas = (conf) => {
        const stanzas = {};
        let current = null;
        for (const raw of conf.split('\n')) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                current = m[1];
                stanzas[current] = [];
            } else if (current) {
                stanzas[current].push(raw);
            }
        }
        return stanzas;
    };
    const nonComment = (stanzas, n) => (stanzas[n] || [])
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    // Session 149 (build 376, round 3): the savedsearches.conf pins below
    // read the stanza's `search = ` value only - the last one, as Splunk runs
    // a repeated key - so a description or another key can neither satisfy
    // a presence pin nor trip an absence pin. transforms.conf and
    // collections.conf are still read whole, through nonComment.
    const searchOf = (stanzas, n) => {
        const lines = (stanzas[n] || []).map((l) => l.replace(/\r$/, '')).filter((l) => /^search\s*=/.test(l));
        return lines.length ? lines[lines.length - 1].replace(/^search\s*=\s*/, '') : '';
    };
    const p325 = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: ${label}: ${detail}`);
            failed = true;
        }
    };

    const saved = parseStanzas(readConf('savedsearches.conf'));

    // (a) the seed stays out of the nodes stanzas -------------------------
    const NODES = ['logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes'];
    NODES.forEach((n) => {
        const body = searchOf(saved, n);
        p325(`[${n}] emits "sid_focused" again (the retired XCP|XHQ seed)`,
            body.length > 0 && body.indexOf('sid_focused') === -1,
            'stored kinds must stay sid_secondary/partner — classification is render-time');
        p325(`[${n}] lost the seedless kind case`,
            body.indexOf('| eval kind = case(canonical_kind == "sid", "sid_secondary", 1==1, "partner")') !== -1,
            'the kind eval changed shape — aggregate/backfill must both carry the seedless form');
    });

    // (b) the RFC row key + local_ip projection ---------------------------
    const EDGES = ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'];
    const KEY_FORM = '| eval _key = case(type=="rfc", id . ":" . bucket_ts . ":" . coalesce(local_ip, ""), 1==1, id . ":" . bucket_ts)';
    EDGES.forEach((n) => {
        const body = searchOf(saved, n);
        p325(`[${n}] lost the metric-scoped RFC row key`,
            body.indexOf(KEY_FORM) !== -1,
            `expected exactly: ${KEY_FORM} — the fallback must stay byte-identical to the `
            + 'legacy key and the rfc branch must include the coalesced local_ip');
        p325(`[${n}] no longer projects local_ip`,
            body.indexOf('| fields _key, id, source_id, target_id, type, direction, local_ip, bucket_ts,') !== -1,
            'local_ip is dropped before outputlookup, so the By-app-server split has no addresses');
        // Build 378 (f): two rfc arms (outbound, inbound) count connections;
        // both keep local_ip in the group-by (the 3conf block pins the rest).
        p325(`[${n}] an rfc arm no longer groups by local_ip`,
            body.indexOf('by sap_sid, rfc_peer_kind, rfc_peer, local_ip, _time') !== -1
            && body.indexOf('by sap_sid, rfc_peer, local_ip, _time') !== -1,
            'without the group-by the projected local_ip is not the per-app-server dimension');
    });

    // (c) the instances measure, end to end -------------------------------
    const DETAIL = ['logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill'];
    DETAIL.forEach((n) => {
        const body = searchOf(saved, n);
        const arms = body.split('values(sap_inst) as instances').length - 1;
        p325(`[${n}] has ${arms} instances arm(s), expected 2`,
            arms === 2,
            'both node_host arms (Arm H by host, Arm S by SAP-field scope) must carry the measure');
        p325(`[${n}] drops instances before outputlookup`,
            body.indexOf('max_dur, instances | outputlookup append=true logserv_topology_detail_rollup') !== -1,
            'the field is computed and then projected away');
    });

    // transforms.conf + collections.conf stay in lockstep (outputlookup
    // writes ONLY fields_list fields; collections field.* keeps the trio
    // convention of 3b).
    const transforms = parseStanzas(readConf('transforms.conf'));
    const collections = parseStanzas(readConf('collections.conf'));
    const tEdges = nonComment(transforms, 'logserv_topology_edges');
    const tDetail = nonComment(transforms, 'logserv_topology_detail_rollup');
    p325('transforms [logserv_topology_edges] fields_list lost local_ip',
        /fields_list = [^\n]*\bdirection, local_ip, bucket_ts\b/.test(tEdges),
        'outputlookup silently drops fields absent from fields_list');
    p325('transforms [logserv_topology_detail_rollup] fields_list lost instances',
        /fields_list = [^\n]*\bmax_dur, instances\b/.test(tDetail),
        'outputlookup silently drops fields absent from fields_list');
    p325('collections [logserv_topology_edges] lost field.local_ip',
        nonComment(collections, 'logserv_topology_edges').indexOf('field.local_ip = string') !== -1,
        'the conf trio (collections/transforms/savedsearches) must move in lockstep');
    p325('collections [logserv_topology_detail_rollup] lost field.instances',
        nonComment(collections, 'logserv_topology_detail_rollup').indexOf('field.instances = string') !== -1,
        'the conf trio (collections/transforms/savedsearches) must move in lockstep');

    // Source pins: the webapp halves of the same contract ------------------
    const H325 = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const src325 = (rel) => fs.readFileSync(path.join(H325, rel), 'utf8');

    const topo = src325('hooks/useTopologyData.ts');
    p325('High Traffic promotion no longer ranks SIDs only',
        topo.indexOf('.filter(([id]) => sidNodeIds.has(id))') !== -1,
        'partner/IP nodes would occupy top-10 slots again (the pre-324 quirk, plan A2)');
    p325('High Traffic promotion call site lost the SIDs-only candidate set',
        topo.indexOf('computeHighTrafficNodeIds(edges, new Set(sidToNodeId.values()))') !== -1,
        'the structural build-224 guard is the candidate set, not the filter alone');
    /* Build 331 / session 112 — the rank width was re-ratified 10 -> 5 (user
     * direction). Pin BOTH the constant's value and that the slice reads the
     * constant, so neither a silent width change nor a bypassing literal can
     * drift alone. */
    p325('High Traffic rank-width constant changed',
        /^const HIGH_TRAFFIC_TOP_N = 5;$/m.test(topo),
        'the ratified rank width (5, session 112) changed silently');
    p325('High Traffic promotion no longer slices by the constant',
        topo.indexOf('.slice(0, HIGH_TRAFFIC_TOP_N)') !== -1,
        'the slice must read HIGH_TRAFFIC_TOP_N, not a literal');
    p325('the By-app-server split no longer reads ALL member rows, rfc-only',
        /appServers: agg\.row\.type === 'rfc'\s*\n?\s*\? buildEdgeAppServers\(agg\.rows\)/.test(topo),
        'a representative-row split would be a fraction of the real volume; a non-rfc split '
        + 'would fabricate app servers for types that store no local_ip');

    const searches325 = src325('topology/searches.ts');
    p325('the bulk host-count read changed shape',
        /export const SEARCH_NODE_HOST_COUNTS[\s\S]*?metric="node_host"[\s\S]*?\| stats dc\(host\) as hosts by scope[\s\S]*?`\.trim\(\)/.test(searches325),
        'the tooltip/facts count must be dc(host) over the SAME node_host metric the Hosts tab reads');
    // The coarse mongod pushdown (review fold): without it the read streams
    // the ENTIRE node_host metric across the 365-day retention on every
    // topology interaction — the history-coupled read class the rollup
    // architecture exists to eliminate. The precise trim must STAY addinfo
    // (DETAIL_RANGE) or the count stops agreeing with the Hosts tab.
    p325('the bulk host-count read lost its coarse bucket_ts pushdown',
        searches325.indexOf('AND bucket_ts>=${lo} AND bucket_ts<=${hi}') !== -1
        && /export const SEARCH_NODE_HOST_COUNTS[\s\S]*?\$\{bounds\}\n\$\{DETAIL_RANGE\}/.test(searches325),
        'mongod would stream the whole retention per dispatch; addinfo must remain the precise trim');
    const hosts325 = /export const SEARCH_NODE_HOSTS[\s\S]*?`\.trim\(\);/.exec(searches325);
    p325('the Hosts read no longer aggregates instances',
        !!hosts325 && hosts325[0].indexOf('values(instances) as instances') !== -1
        && /\| fields host, count, sourcetypes, instances,/.test(hosts325[0]),
        'the measure is stored but never read, so the tab renders no instance list');

    const integ325 = src325('dashboards/IntegrationTopology.tsx');
    p325('the bulk host-count read is no longer dispatched with a resolved window',
        /SEARCH_NODE_HOST_COUNTS\(\s*\n?\s*resolveTimeSpec\(timeRange\.earliest\),\s*\n?\s*resolveTimeSpec\(timeRange\.latest\),/.test(integ325),
        'the tooltip/facts Hosts row would silently never render (or stream the whole retention)');
    // The stale-window guard: useSearch keeps the previous results across a
    // re-dispatch, so without the loading gate a picker change presents the
    // PREVIOUS window's counts as current-window facts for several seconds.
    p325('the host-count map no longer empties while a dispatch is in flight',
        /if \(hostCountsResult\.loading\) return map;/.test(integ325),
        'a stale count would render as a current-window fact after every picker change');
    p325('the facts-row host count is no longer gated to SID + tenant nodes',
        /const eligible = selectedNode\.kind === 'sid_focused'\s*\n?\s*\|\| selectedNode\.kind === 'sid_secondary'\s*\n?\s*\|\| selectedNode\.tag === 'TENANT'/.test(integ325),
        'a partner IP would get a "Hosts (in range)" row naming far-end hosts it does not own');
    p325('the host-count map is attached to the layout-feeding node array again',
        integ325.indexOf('HostCountContext.Provider') !== -1
        && src325('hooks/useTopologyData.ts').indexOf('hostCount') === -1
        && integ325.indexOf('hostCount, callBuckets') === -1,
        'the late-arriving SPL result would re-fire the layout effect + manualFitView '
        + 'over the user viewport (the review-fold this delivery design exists for)');

    // The tooltip surfaces: SidNode consumes the context (SID counts carry no
    // label-collision hazard); PartnerNode must NOT render a hosts row — of
    // its nodes only tenants would have one, and a tenant's label-scoped
    // count is the application system's hosts, which a name/value tooltip
    // row cannot hedge (§8a-5). The sidebar facts row carries the hedge.
    const sidNode325 = src325('components/topology/nodeTypes/SidNode.tsx');
    p325('SidNode no longer reads the host-count context',
        sidNode325.indexOf('useContext(HostCountContext)') !== -1
        && /hosts=\{hostCount\}/.test(sidNode325),
        'the tooltip Hosts row silently never renders');
    p325('PartnerNode passes a hosts row again (the tenant label-collision misread)',
        src325('components/topology/nodeTypes/PartnerNode.tsx').indexOf('hosts={') === -1,
        'a tenant tooltip would present the application system\'s hosts as the tenant\'s');
    const sidebar325 = src325('components/topology/TopologyRightSidebar.tsx');
    p325('the tenant facts-row hedge is gone',
        /nodeHostCount != null && nodeHostCount > 0\s*\n?\s*&& selectedAttribution\?\.kind === 'tenant_db'/.test(sidebar325),
        'the tenant "Hosts (in range)" row would present the application system\'s hosts unhedged');

    console.log('check-diagnostics: build-325 topology conf contract pinned '
        + '(seedless nodes, RFC key + local_ip, instances end-to-end, promotion + host-count delivery pins)');
}

// --- 3q: the build-326 group-select contract (design §8a) -------------------
//
// The gesture's safety + correctness live in a handful of literals that a
// refactor can silently regress:
//   - deleteKeyCode={null}: null, NOT undefined — @xyflow's destructuring
//     default restores 'Backspace', and Backspace with a group selected
//     would delete the whole cluster from flow state (§8a-19).
//   - the NodesSelection rect suppression: without display:none the rect
//     covers the selection bbox with pointer-events:all — pane clicks
//     inside it die, interior nodes go inert, and its auto-focus routes
//     arrow keys into an un-tracked group move (§8a-1).
//   - the .selected transition kill: only the grabbed node gets RF's
//     "dragging" class, so without it every other member chases the
//     pointer through the 600 ms glide (§8a-5).
//   - the edge select-change filter: RF selects edges by CONNECTIVITY,
//     over-claiming the group, and the flags would persist (§8a-10).
//   - single-delta snap: per-node rounding deforms the group (§8a-3).
//   - NO onSelectionDragStop: it double-fires alongside onNodeDragStop
//     for the same gesture (§8a-2).
//   - the inspected/selected decouple: writing `selected` from
//     selectedNodeId again would clobber every group selection (§8a/D1).
{
    const H = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const src = (rel) => fs.readFileSync(path.join(H, rel), 'utf8');
    const pin = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: ${label}: ${detail}`);
            failed = true;
        }
    };

    const graph = src('components/topology/TopologyGraph.tsx');
    // Line-anchored: the explanatory comments also NAME these literals, so a
    // bare indexOf survives its own mutation (the session-107 comment trap).
    pin('deleteKeyCode is no longer the literal null',
        /^\s*deleteKeyCode=\{null\}\s*$/m.test(graph),
        'undefined (or absence) restores Backspace-deletes-selected-nodes via the RF default');
    pin('selectNodesOnDrag is no longer the literal false',
        /^\s*selectNodesOnDrag=\{false\}\s*$/m.test(graph),
        'a plain solo drag would paint the group visual on the grabbed node');
    pin('Shift left multiSelectionKeyCode',
        /multiSelectionKeyCode=\{\[[^\]]*'Shift'[^\]]*\]\}/.test(graph)
            && /multiSelectionKeyCode=\{\[[^\]]*'Meta'[^\]]*\]\}/.test(graph)
            && /multiSelectionKeyCode=\{\[[^\]]*'Control'[^\]]*\]\}/.test(graph),
        'Shift+click would REPLACE the selection instead of toggling membership');
    pin('the NodesSelection rect suppression is gone',
        /\.react-flow__nodesselection-rect\s*\{\s*display:\s*none;/.test(graph),
        'the rect swallows pane clicks + interior nodes and routes arrow keys into un-tracked moves');
    pin('the .selected transition kill is gone',
        /\.react-flow__node\.selected\s*\{\s*transition:\s*none;/.test(graph),
        'non-grabbed group members would rubber-band through the 600 ms glide during a group drag');
    pin('the edge select-change filter is gone',
        /changes\.filter\(\(c\) => c\.type !== 'select'\)/.test(graph),
        'RF connectivity-selected edge flags would persist in flowEdges');
    pin('snap is no longer single-delta',
        graph.indexOf('position: { x: n.position.x + dx, y: n.position.y + dy }') > 0
            && graph.indexOf('position: snapped } : n') === -1,
        'per-node rounding deforms a snapped group');
    pin('onSelectionDragStop crept in',
        !/onSelectionDragStop=\{/.test(graph),
        'it double-fires alongside onNodeDragStop for the same drag (§8a-2); the comments may name it, the props must not');
    pin('the selection effect writes RF `selected` again',
        graph.indexOf('selected: fn.id === selectedNodeId') === -1
            && graph.indexOf('inspected: n.id === selectedNodeId') > 0,
        'the Details-panel selection would clobber every group selection');
    pin('group membership no longer survives the nodes-sync rebuild',
        graph.indexOf('selected: prevSelected.has(n.id)') > 0,
        'Refresh / time-range change / Save Layout would silently wipe the group');
    pin('the Escape guard lost its dialog check',
        graph.indexOf('[role="dialog"], [aria-modal="true"]') > 0,
        'Escape would clear the group behind an open modal the user was dismissing');

    const sid = src('components/topology/nodeTypes/SidNode.tsx');
    const partner = src('components/topology/nodeTypes/PartnerNode.tsx');
    pin('SidNode lost the inspected/grouped split',
        sid.indexOf('$inspected={d.inspected ?? false}') > 0
            && sid.indexOf('$grouped={selected ?? false}') > 0,
        'the Details glow and group outline must come from different flags');
    pin('PartnerNode lost the inspected/grouped split',
        partner.indexOf('$inspected={d.inspected ?? false}') > 0
            && partner.indexOf('$grouped={selected ?? false}') > 0
            && (partner.match(/p\.\$grouped \?/g) || []).length === 3,
        'all three variant elements (.square/.dbDisc/.tenantDisc) must carry the group outline');
    pin('a node component still reads the RF selected prop as the inspected glow',
        sid.indexOf('p.$selected') === -1 && partner.indexOf('p.$selected') === -1,
        'RF selected now means group membership, not inspection');

    console.log('check-diagnostics: build-326 group-select contract pinned '
        + '(deleteKeyCode null, rect suppression, transition kill, edge filter, '
        + 'single-delta snap, no onSelectionDragStop, inspected/grouped decouple)');
}

// --- 3r: the build-329 IP-enrichment contract (session 112) -----------------
//
// Four halves that silently degrade apart:
//  (a) the conf trio — collections.conf fields, the transforms.conf
//      fields_list (outputlookup silently DROPS fields absent from it), the
//      aggregate/backfill/retention stanzas. The aggregate must stay
//      SINGLE-PIPELINE: it is a DAILY search over a 30-day window, and
//      non-first `| union` arms auto-finalize at ~30s wall-clock — the
//      session-054 truncation class this shape exists to avoid.
//  (b) the evidence rules the ratified session-112 decisions pin in SPL:
//      Windows 4624-only + the WorkstationName self-guard, ssh
//      session-lines-only, the machine-account filter, gateway EXCLUDED,
//      and the "<ip>:<evidence_source>" row key.
//  (c) the registry fold — Clear/Backfill/History in Settings -> Dashboard
//      Data fan out over the registry, so a missing entry orphans the
//      collection from every admin surface (the session-063 rule).
//  (d) the webapp delivery discipline — context + sidebar prop, NEVER the
//      node arrays (the session-110 layout-clobber class), the label left
//      as the raw IP (refineTag classifies from labels — session-107 trap),
//      and the ELK/collide geometry lockstep for the added label lines.
{
    const DEFAULT_DIR = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const HOME_DIR = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const readConf = (name) => fs.readFileSync(path.join(DEFAULT_DIR, name), 'utf8');
    const readHome = (rel) => fs.readFileSync(path.join(HOME_DIR, rel), 'utf8');
    const parseStanzas = (conf) => {
        const stanzas = {};
        let current = null;
        for (const raw of conf.split('\n')) {
            const m = /^\[(.+)\]\s*$/.exec(raw.trim());
            if (m) {
                current = m[1];
                stanzas[current] = [];
            } else if (current) {
                stanzas[current].push(raw);
            }
        }
        return stanzas;
    };
    const nonComment = (stanzas, n) => (stanzas[n] || [])
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    const p329 = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3r ${label}: ${detail}`);
            failed = true;
        }
    };

    // (a) conf trio lockstep ------------------------------------------------
    const collections = parseStanzas(readConf('collections.conf'));
    const transforms = parseStanzas(readConf('transforms.conf'));
    const saved = parseStanzas(readConf('savedsearches.conf'));

    const collBody = nonComment(collections, 'logserv_topology_ip_enrichment');
    const collFields = (collBody.match(/^field\.([a-z_]+)\s*=/gm) || [])
        .map((l) => l.replace(/^field\./, '').replace(/\s*=.*$/, ''));
    const tfBody = nonComment(transforms, 'logserv_topology_ip_enrichment');
    const tfListMatch = /fields_list\s*=\s*(.+)$/m.exec(tfBody);
    const tfFields = tfListMatch ? tfListMatch[1].split(',').map((s) => s.trim()) : [];
    p329('collections stanza missing', collFields.length > 0,
        '[logserv_topology_ip_enrichment] not found in collections.conf');
    p329('transforms kvstore stanza missing',
        tfBody.indexOf('external_type = kvstore') !== -1 && tfFields.length > 0,
        'outputlookup needs the transforms.conf lookup stanza (session-035 rule)');
    const tfWithoutKey = tfFields.filter((f) => f !== '_key').sort().join(',');
    p329('collections fields != transforms fields_list',
        tfWithoutKey === collFields.slice().sort().join(','),
        `collections [${collFields.sort().join(',')}] vs fields_list-minus-_key [${tfWithoutKey}]`);
    p329('fields_list must carry _key (upsert identity)', tfFields.indexOf('_key') !== -1,
        'the retention rewrite + upsert path lose row identity without _key in fields_list');

    // (b) the aggregate/backfill SPL + evidence rules -----------------------
    const AGG = 'logserv_topology_enrichment_aggregate';
    const BF = 'logserv_topology_enrichment_backfill';
    const RET = 'logserv_topology_enrichment_retention';
    const searchLine = (n) => {
        const m = /^search\s*=\s*(.*)$/m.exec(nonComment(saved, n));
        return m ? m[1] : '';
    };
    const aggSpl = searchLine(AGG);
    const bfSpl = searchLine(BF);
    p329('aggregate stanza missing', aggSpl.length > 0, `[${AGG}] has no search line`);
    p329('backfill stanza missing', bfSpl.length > 0, `[${BF}] has no search line`);
    p329('aggregate != backfill SPL', aggSpl === bfSpl,
        'the backfill IS one recompute — the two must stay byte-identical');
    p329('aggregate must be single-pipeline (no | union)',
        aggSpl.indexOf('| union') === -1 && aggSpl.indexOf('`sap_logserv_idx_macro`') === 0,
        'a daily -30d | union would hit the ~30s non-first-arm truncation (session-054)');
    p329('aggregate must NOT carry a literal `search` prefix',
        aggSpl.indexOf('search ') !== 0,
        'a SAVED search auto-prepends search context — a literal prefix becomes a '
        + 'search TERM and only events containing the word "search" match '
        + '(caught live, session 112; the REST-oneshot prefix rule INVERTS here)');
    p329('aggregate lost its outputlookup target',
        aggSpl.indexOf('| outputlookup append=true logserv_topology_ip_enrichment') !== -1,
        'the collection write vanished');
    p329('Windows arm must stay 4624-only', aggSpl.indexOf('EventCode=4624') !== -1,
        'failed logon guesses must not claim users (ratified session-112 rule)');
    p329('Windows self-guard dropped',
        aggSpl.indexOf('lower(mvindex(split(WorkstationName,"."),0)) != lower(mvindex(split(host,"."),0))') !== -1,
        'WorkstationName is the LOCAL machine for interactive/service logons — without the guard the demo/self-reference class returns');
    p329('ssh arm must stay session-lines-only',
        aggSpl.indexOf('("Accepted" OR "Starting session" OR "Close session")') !== -1,
        '"Failed password" lines would flood scanner-guessed names');
    p329('machine-account filter dropped', aggSpl.indexOf('like(enr_user, "%$")') !== -1,
        'trailing-$ accounts are machines, not users');
    p329('gateway must stay EXCLUDED as an evidence source',
        aggSpl.indexOf('sap:abap:gateway') === -1,
        'peer_ip and gw_remote_host never co-occur — correlation is guesswork (ratified suppress-over-guess)');
    p329('row key form changed',
        aggSpl.indexOf('| eval _key = ip . ":" . evidence_source') !== -1,
        'the upsert identity is "<ip>:<evidence_source>"');
    const aggBody = (saved[AGG] || []).join('\n');
    p329('aggregate cron slot moved', /^cron_schedule\s*=\s*32 2 \* \* \*\s*$/m.test(aggBody),
        'the census validated 32 2 * * * — re-run the census before moving it');

    // (c) retention ----------------------------------------------------------
    const retSpl = searchLine(RET);
    p329('retention lost override_if_empty=false',
        retSpl.indexOf('outputlookup override_if_empty=false logserv_topology_ip_enrichment') !== -1,
        'a mongod-warm-up empty read would WIPE the collection (session-096 rule)');
    p329('retention lost the 365d window / future clamp',
        retSpl.indexOf('relative_time(now(), "-365d")') !== -1 && retSpl.indexOf('last_seen <= now() + 86400') !== -1,
        'the trim predicate changed shape');
    const retBody = (saved[RET] || []).join('\n');
    p329('retention cron slot moved', /^cron_schedule\s*=\s*34 2 \* \* \*\s*$/m.test(retBody),
        'the census validated 34 2 * * * — re-run the census before moving it');

    // (d) registry fold + webapp delivery pins -------------------------------
    const registry = loadTs(path.resolve(__dirname, '../src/main/webapp/pages/home/routes/rollupRegistry'));
    const topo = (registry.ROLLUPS || []).find((d) => d.key === 'topology_graph');
    p329('registry: collection not folded into topology_graph',
        !!topo && topo.collections.indexOf('logserv_topology_ip_enrichment') !== -1,
        'Clear/Backfill/env-report would orphan the collection');
    p329('registry: aggregate/backfill/retention not folded',
        !!topo
        && topo.aggregateSearches.indexOf(AGG) !== -1
        && topo.backfillStanzas.indexOf(BF) !== -1
        && topo.retentionSearches.indexOf(RET) !== -1,
        'the three stanzas must ride the topology_graph entry');
    p329('registry: the flat collection must NOT gate completeness',
        !!topo && topo.completenessCollections.indexOf('logserv_topology_ip_enrichment') === -1,
        'no bucket_ts — an oldest-bucket check would read it as forever-empty');

    const useTopologyDataSrc = readHome('hooks/useTopologyData.ts');
    p329('useTopologyData must NOT touch enrichment (the layout-clobber class)',
        useTopologyDataSrc.indexOf('topology/enrichment') === -1
        && useTopologyDataSrc.indexOf('useIpEnrichment') === -1,
        'delivery is context + sidebar prop, never the node arrays (session-110 rule)');
    const partnerSrc = readHome('components/topology/nodeTypes/PartnerNode.tsx');
    p329('PartnerNode lost the context consumption',
        partnerSrc.indexOf('useContext(IpEnrichmentContext)') !== -1
        && partnerSrc.indexOf('nodeUserLine(') !== -1,
        'the node lines render from IpEnrichmentContext');
    p329('PartnerNode label must stay the raw value',
        partnerSrc.indexOf('<div className="label">{d.label}</div>') !== -1,
        'refineTag classifies from LABELS — enrichment must stay in separate elements (session-107 trap)');
    const integSrc = readHome('dashboards/IntegrationTopology.tsx');
    p329('IntegrationTopology lost the provider or sidebar prop',
        integSrc.indexOf('<IpEnrichmentContext.Provider value={ipEnrichment}>') !== -1
        && integSrc.indexOf('ipEnrichment={ipEnrichment}') !== -1,
        'both delivery paths must stay wired');
    const sidebarSrc = readHome('components/topology/TopologyRightSidebar.tsx');
    p329('sidebar lost the Overview rows',
        sidebarSrc.indexOf('groupUsersBySource(') !== -1,
        'the source-labeled Users row is the ratified decision-2 surface');
    const GEOM = 'return { width: 95, height: 175 };';
    p329('layoutLayered partner box lost the enrichment height',
        readHome('topology/layoutLayered.ts').indexOf(GEOM) !== -1,
        'partner 95x175 carries the added label lines (lockstep)');
    p329('layoutMrtree partner box lost the enrichment height',
        readHome('topology/layoutMrtree.ts').indexOf(GEOM) !== -1,
        'partner 95x175 carries the added label lines (lockstep)');
    p329('partner collide radius reverted',
        /^const DEFAULT_COLLIDE_PARTNER = 110;$/m.test(readHome('topology/layout.ts')),
        'collide 110 pairs with the 95x175 ELK boxes (build 329)');

    console.log(
        'check-diagnostics: build-329 IP-enrichment contract pinned '
        + '(conf trio lockstep, single-pipeline aggregate, evidence rules, '
        + 'registry fold, context delivery, geometry lockstep)',
    );
}

// --- 3tc: topology loopback 127.0.0.0/8 + the never-written fields (build 377) -
//
// Build 377, items e2, g and k's topology wording (session 155, decisions U36,
// U38 option 2a and U42):
//  (a) every HANA audit loopback filter in the topology and IP-enrichment
//      searches is the 127.0.0.0/8 form. Each `sourcetype=sap:hana:audit` arm
//      of the nodes, edges and detail searches runs
//      `| where NOT cidrmatch("127.0.0.0/8", client_ip)` as its first command;
//      the enrichment search prefilters with `NOT client_ip=127.*` and drops
//      loopback with `NOT cidrmatch("127.0.0.0/8", enr_ip)`, its 0.0.0.0 /
//      "-" / ::1 guards kept. No exact 127.0.0.1 test is left in these eight
//      stanzas, and every cidrmatch there names 127.0.0.0/8. The exact test
//      let 127.0.0.2 - 127.255.255.255 through as edge endpoints.
//  (b) each topology aggregate search is byte-identical to its backfill twin:
//      the backfill is the same search over a longer window, so a one-sided
//      edit makes the Settings backfill write rows the hourly run never would.
//      (The enrichment pair is pinned by 3r.)
//  (c) the nodes and edges conf trio agree EXACTLY: the aggregate's trailing
//      `| fields` list = the transforms fields_list (same order) = the
//      collections field.* set + _key. outputlookup silently drops a field
//      missing from fields_list, and a field declared but never projected
//      (the edge ICM task max/avg and the node health percentage, until 377)
//      ships a contract no search honours. Named absence pins for those three.
//  (d) the webapp halves of g: no icm_tasks_* / icmTasks* in useTopologyData
//      or the TopologyEdge type, no node health percentage in the types,
//      SidNode or the sidebar, and the SidNode halo is the constant accent.
//  (e) topology/searches.ts holds KV rollup reads only: none of the seven
//      deleted on-demand builders, no raw `sap_logserv_idx_macro` search (the
//      dead SEARCH_HANA_EDGES carried the stale exact loopback filter that was
//      cited as precedent), and no conf comment names a deleted builder.
//  (f) item k in the topology (U42): the hana_tenant edge timings
//      (hana_op_p95_ms / hana_op_max_ms, from hana_op_duration_ms) time hdbcons
//      (HANA console) commands in a tenant's trace files, not SQL - the HANA
//      Trace dashboard renamed the same field. Outside its comments the
//      topology sidebar names no "SQL" (case-sensitive word: the MSSQL vendor
//      tag and lower-case field names do not match), and the edges aggregate's
//      description says hdbcons.
{
    const D3TC = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const H3TC = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const conf3tc = (name) => fs.readFileSync(path.join(D3TC, name), 'utf8');
    const home3tc = (rel) => fs.readFileSync(path.join(H3TC, rel), 'utf8');
    const stanzas3tc = (conf) => {
        const out = {};
        let cur = null;
        for (const raw of conf.split('\n')) {
            const line = raw.replace(/\r$/, '');
            const m = /^\[(.+)\]\s*$/.exec(line.trim());
            if (m) {
                cur = m[1];
                out[cur] = [];
            } else if (cur) {
                out[cur].push(line);
            }
        }
        return out;
    };
    // The stanza's `search = ` value only - the last one, as Splunk runs a
    // repeated key - so comments and descriptions neither satisfy nor trip.
    const search3tc = (st, n) => {
        const lines = (st[n] || []).filter((l) => /^search\s*=/.test(l));
        return lines.length ? lines[lines.length - 1].replace(/^search\s*=\s*/, '') : '';
    };
    const nonComment3tc = (st, n) => (st[n] || []).filter((l) => !l.trim().startsWith('#'));
    const p3tc = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3tc ${label}: ${detail}`);
            failed = true;
        }
    };
    const saved = stanzas3tc(conf3tc('savedsearches.conf'));
    const transforms = stanzas3tc(conf3tc('transforms.conf'));
    const collections = stanzas3tc(conf3tc('collections.conf'));

    // (a) loopback -------------------------------------------------------------
    const LOOP_STANZAS = [
        'logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes',
        'logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges',
        'logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill',
    ];
    const ENRICH_STANZAS = ['logserv_topology_enrichment_aggregate', 'logserv_topology_enrichment_backfill'];
    const CIDR_FILTER = 'where NOT cidrmatch("127.0.0.0/8", client_ip)';
    let hanaArms3tc = 0;
    LOOP_STANZAS.concat(ENRICH_STANZAS).forEach((n) => {
        const s = search3tc(saved, n);
        p3tc(`[${n}] has no search line`, s.length > 0, 'the stanza is gone or renamed');
        p3tc(`[${n}] tests the exact loopback 127.0.0.1`,
            s.indexOf('127.0.0.1') === -1,
            'loopback is 127.0.0.0/8: cidrmatch("127.0.0.0/8", <field>), never an exact 127.0.0.1');
        const cidrs = s.match(/cidrmatch\(\s*"[^"]*"/g) || [];
        p3tc(`[${n}] has a cidrmatch on a range other than 127.0.0.0/8`,
            cidrs.every((c) => /"127\.0\.0\.0\/8"$/.test(c)),
            `found ${cidrs.join(', ')}`);
    });
    LOOP_STANZAS.forEach((n) => {
        const s = search3tc(saved, n);
        // Each hana:audit arm: its base search up to the first pipe, then the
        // arm's first command, which must be the cidrmatch filter.
        const re = /sourcetype=sap:hana:audit\b[^|\]]*\|\s*([^|\]]*?)\s*(?=\||\])/g;
        let m;
        let arms = 0;
        while ((m = re.exec(s)) !== null) {
            arms += 1;
            p3tc(`[${n}] a sap:hana:audit arm does not start with the 127.0.0.0/8 loopback filter`,
                m[1] === CIDR_FILTER,
                `expected "| ${CIDR_FILTER}" as the arm's first command, found "| ${m[1].slice(0, 80)}"`);
        }
        p3tc(`[${n}] has no sap:hana:audit arm`, arms > 0, 'the loopback pin has nothing to read');
        hanaArms3tc += arms;
    });
    ENRICH_STANZAS.forEach((n) => {
        const s = search3tc(saved, n);
        p3tc(`[${n}] lost the HANA audit loopback prefilter`,
            s.indexOf('(sourcetype=sap:hana:audit client_ip=* NOT client_ip=127.*)') !== -1,
            'the base search drops 127.0.0.0/8 HANA clients before the rex/eval chain');
        p3tc(`[${n}] lost the 127.0.0.0/8 enrichment guard or a junk guard`,
            s.indexOf('| where isnotnull(enr_ip) AND NOT cidrmatch("127.0.0.0/8", enr_ip)'
                + ' AND enr_ip!="0.0.0.0" AND enr_ip!="-" AND enr_ip!="::1" |') !== -1,
            'expected the where clause with the cidrmatch and the 0.0.0.0, "-" and ::1 guards');
    });

    // (b) aggregate == backfill --------------------------------------------------
    const PAIRS3TC = [
        ['logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes'],
        ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'],
        ['logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill'],
        ['logserv_topology_aggregate_inventory', 'logserv_topology_backfill_inventory'],
    ];
    PAIRS3TC.forEach(([agg, bf]) => {
        p3tc(`[${agg}] and [${bf}] differ`,
            search3tc(saved, agg).length > 0 && search3tc(saved, agg) === search3tc(saved, bf),
            'the backfill is the same search over a longer window - change both or neither');
    });

    // (c) the nodes / edges conf trio, exactly ---------------------------------------
    [
        ['logserv_topology_nodes', 'logserv_topology_aggregate_nodes'],
        ['logserv_topology_edges', 'logserv_topology_aggregate_edges'],
    ].forEach(([coll, agg]) => {
        const s = search3tc(saved, agg);
        const fm = new RegExp(`\\| fields ([^|]+?) \\| outputlookup append=true ${coll}$`).exec(s);
        const projected = fm ? fm[1].split(',').map((x) => x.trim()) : [];
        const tl = /^fields_list\s*=\s*(.+)$/m.exec(nonComment3tc(transforms, coll).join('\n'));
        const listed = tl ? tl[1].split(',').map((x) => x.trim()) : [];
        const declared = nonComment3tc(collections, coll)
            .map((l) => /^field\.([A-Za-z0-9_]+)\s*=/.exec(l))
            .filter(Boolean)
            .map((x) => x[1]);
        p3tc(`[${agg}] has no trailing "| fields ... | outputlookup append=true ${coll}"`,
            projected.length > 0, 'the projection could not be read');
        p3tc(`[${agg}] | fields != transforms [${coll}] fields_list`,
            JSON.stringify(projected) === JSON.stringify(listed),
            `projected [${projected.join(', ')}] vs fields_list [${listed.join(', ')}]`);
        p3tc(`collections [${coll}] field.* != transforms fields_list minus _key`,
            declared.length > 0
                && JSON.stringify(declared.slice().sort())
                    === JSON.stringify(listed.filter((f) => f !== '_key').sort()),
            `declared [${declared.join(', ')}] vs fields_list [${listed.join(', ')}]`);
    });
    const NEVER3TC = {
        logserv_topology_nodes: ['health_pct'],
        logserv_topology_edges: ['icm_tasks_max', 'icm_tasks_avg'],
    };
    Object.keys(NEVER3TC).forEach((coll) => {
        NEVER3TC[coll].forEach((f) => {
            p3tc(`${f} is back in transforms [${coll}]`,
                nonComment3tc(transforms, coll).join('\n').indexOf(f) === -1,
                'no saved search writes it (build 377, U38)');
            p3tc(`${f} is back in collections [${coll}]`,
                nonComment3tc(collections, coll).join('\n').indexOf(`field.${f}`) === -1,
                'no saved search writes it (build 377, U38)');
        });
    });
    ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'].forEach((n) => {
        p3tc(`[${n}] names icm_tasks again`,
            search3tc(saved, n).indexOf('icm_tasks') === -1,
            'an edge cannot carry ICM task load (an ASYNC_RFC line names no peer); Work Process Performance shows it');
    });
    ['logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes'].forEach((n) => {
        p3tc(`[${n}] names health_pct again`,
            search3tc(saved, n).indexOf('health_pct') === -1,
            'node health is the read-time call-bucket ring, not a stored field');
    });

    // (d) the webapp halves of g ------------------------------------------------------
    const ICM_RE = /\bicm_tasks_(?:max|avg)\b|\bicmTasks(?:Max|Avg)\b/;
    p3tc('useTopologyData reads the edge ICM task fields again',
        !ICM_RE.test(home3tc('hooks/useTopologyData.ts')),
        'no saved search writes them (build 377, U38)');
    const types3tc = home3tc('topology/types.ts');
    p3tc('topology/types.ts declares the edge ICM task fields again',
        !ICM_RE.test(types3tc), 'no saved search writes them (build 377, U38)');
    p3tc('topology/types.ts declares a node health percentage again',
        !/\bhealthPct\b/.test(types3tc), 'no saved search writes it (build 377, U38 option 2a)');
    const sid3tc = home3tc('components/topology/nodeTypes/SidNode.tsx');
    p3tc('SidNode colours its halo from a health percentage again',
        !/\bhealthPct\b/.test(sid3tc) && sid3tc.indexOf('haloColor') === -1
            && sid3tc.indexOf('const HALO_COLOR = logservTheme.colors.cyanAccent;') !== -1
            && sid3tc.indexOf('const halo = HALO_COLOR;') !== -1,
        'the halo is the constant accent; node health is the call-bucket ring');
    p3tc('the topology sidebar renders a node health percentage again',
        !/\bhealthPct\b/.test(home3tc('components/topology/TopologyRightSidebar.tsx')),
        'no saved search writes it (build 377, U38 option 2a)');

    // (e) KV reads only in topology/searches.ts; no stale builder names ------------------
    const searches3tc = home3tc('topology/searches.ts');
    const DEAD3TC = ['SEARCH_INVENTORY', 'SEARCH_RFC_EDGES', 'SEARCH_HANA_EDGES', 'SEARCH_HTTP_EDGES',
        'SEARCH_HANA_TENANT_EDGES', 'SEARCH_ACTIVITY', 'SEARCH_CALLS_PER_HOUR'];
    DEAD3TC.forEach((b) => {
        p3tc(`topology/searches.ts defines the deleted ${b} again`,
            !new RegExp(`\\b${b}\\b`).test(searches3tc),
            'nothing imports it; the shipped SPL is the logserv_topology_* saved searches');
    });
    p3tc('topology/searches.ts builds a raw index search again',
        searches3tc.indexOf('sap_logserv_idx_macro') === -1,
        'every topology read is a KV rollup read; raw-index builders here drifted from the shipped searches');
    ['savedsearches.conf', 'collections.conf'].forEach((f) => {
        const t = conf3tc(f);
        DEAD3TC.forEach((b) => {
            p3tc(`${f} names the deleted ${b}`, !new RegExp(`\\b${b}\\b`).test(t),
                'a comment points at a builder that no longer exists');
        });
    });

    // (f) the hana_tenant timings are hdbcons command timings, not SQL ---------------
    // Comments are stripped first (they may explain the rename); JSX text and
    // string literals are what the user reads.
    const side3tc = home3tc('components/topology/TopologyRightSidebar.tsx')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const sql3tc = /\bSQL\b/.exec(side3tc);
    p3tc('the topology sidebar calls the hana_tenant hdbcons timings SQL again', !sql3tc,
        `found "${sql3tc ? side3tc.slice(Math.max(0, sql3tc.index - 30), sql3tc.index + 20).trim() : ''}"`
        + ' - hana_op_duration_ms times hdbcons (HANA console) commands, as HANA Trace says');
    const edgesDesc3tc = (saved.logserv_topology_aggregate_edges || [])
        .filter((l) => /^description\s*=/.test(l)).join('\n');
    p3tc('[logserv_topology_aggregate_edges] description calls the hana_tenant hdbcons timings SQL again',
        edgesDesc3tc.indexOf('hdbcons') !== -1 && !/\bSQL\b/.test(edgesDesc3tc),
        'the HANA Tenant per-type aggregate is the hdbcons command duration p95/max');

    console.log(`check-diagnostics: 3tc topology loopback is 127.0.0.0/8 (${hanaArms3tc} HANA audit arms`
        + ` + the enrichment pair), ${PAIRS3TC.length} aggregate/backfill pairs identical, nodes/edges conf trio`
        + ' exact, never-written fields and deleted builders absent, hana_tenant timings named hdbcons');
}

// --- 3conf: the build-378 conf contract (SAP Router edges, RFC connections, HANA host + trace) -
//
// Build 378, items e, f, h1 (+U5) and i1 (session 156, decisions U29-U33, U37, U3/U4/U5, U39):
//  (a) h1: no App props.conf stanza aliases or evaluates anything INTO host -
//      host stays the indexed LogServ host (for HANA audit: the HANA host that
//      wrote the record); the client name is src_host in [sap:hana:audit]; the
//      four client groups of EXTRACT-basic_fields are optional (U5), so a
//      record with no client still parses.
//  (b) i1: [sap:hana:tracelogs] has no severity alias (U39), hana_op_duration_ms
//      is the EVAL's alone, and the trace / backup lines are anchored. The
//      behaviour is the hanaTraceProps consistency suite's.
//  (c) e / f props: the new fields exist under their fixed names, and the
//      abapnet rollup's key extractions (gw_function, gw_remote_host,
//      gw_service) and the peer / local IP extractions are byte-unchanged;
//      a 3298 target (niping) is no dispatcher and has no instance number.
//  (d) f, the edges search: two rfc arms (outbound rfc_in==0, inbound
//      rfc_in==1) that count CONNECTIONS - closed connections plus distinct
//      broken ones (keyed by the peer ip:port AND the local port: on an
//      outbound line the peer port is the remote listener), errors = the
//      broken ones, so errors never exceed calls - keep local_ip through the
//      stats (a "(none)" placeholder and back to null: no reliance on how
//      Splunk groups an empty string), and no gateway arm counts lines as
//      calls again. ONE orientation predicate and ONE partner derivation -
//      loopback partners (127.0.0.0/8) dropped - byte-equal in the two edges
//      arms and the three rfc detail arms: a drift between them points the
//      Edge Details tabs at an edge id no row has.
//  (e) e: one saprouter edges arm and one per detail metric, each dropping
//      127.0.0.0/8 targets with an explicit isnotnull (cidrmatch is false on an
//      absent value); the router host node arm (kind saprouter, tag ROUTER),
//      the CONNECT TO target IP node arm and the sapms<SID> inventory arm.
//      Build 379 (session 160, user decision): the inventory prefers each
//      entity's MOST RECENT SID. No arm decides a SID on its own (no
//      mvcount(sids) / values() in an arm): each counts events and keeps the
//      newest one per entity and SID. The tail is pinned exactly: an
//      order-free stats over the arms first (so the Settings backfill's
//      staged combine equals the union), then the SIDs whose newest event
//      falls in the entity's most recent hour (floor(last_seen/3600)*3600 -
//      gate 3s does not reach these stanzas, whose names end in _inventory),
//      then the most events; an exact tie writes no row (the old row stays).
//  (f) i1 knock-on: the hana_tenant warning_count test is null-safe (record
//      files now have no severity; a != test on an absent value is false).
//  (g) U37: the ES edge anomaly baselines `by id, type` (edge rows carry no
//      source / target field) and derives source / target from the row's
//      spl_filter_clauses, and every $field$ token, nes_fields entry and risk
//      object field of the stanza is a field the search writes or an edge row
//      carries; h1: the two HANA correlation searches list the client hosts
//      (src_hosts) beside the HANA host.
{
    const D3C = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const conf3c = (name) => fs.readFileSync(path.join(D3C, name), 'utf8').replace(/\r\n/g, '\n');
    const stanzas3c = (text) => {
        const out = {};
        let cur = null;
        text.split('\n').forEach((line) => {
            const m = /^\[(.+)\]\s*$/.exec(line.trim());
            if (m) {
                cur = m[1];
                out[cur] = [];
            } else if (cur && !/^\s*#/.test(line)) {
                out[cur].push(line);
            }
        });
        return out;
    };
    const key3c = (st, n, k) => {
        const ls = (st[n] || []).filter((l) => l.startsWith(`${k} = `));
        return ls.length ? ls[ls.length - 1].slice(k.length + 3) : '';
    };
    const p3c = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3conf ${label}: ${detail}`);
            failed = true;
        }
    };
    // Quote-aware `| union` splitter, the RollupBackfillPanel's parseUnion.
    const arms3c = (spl) => {
        const s = spl.trim().replace(/^\|\s*union\s+/, '');
        const arms = [];
        let depth = 0;
        let start = -1;
        let inQ = false;
        for (let i = 0; i < s.length; i += 1) {
            const ch = s[i];
            if (ch === '"') {
                let bs = 0;
                for (let j = i - 1; j >= 0 && s[j] === '\\'; j -= 1) bs += 1;
                if (bs % 2 === 0) inQ = !inQ;
            } else if (!inQ && ch === '[') {
                if (depth === 0) start = i + 1;
                depth += 1;
            } else if (!inQ && ch === ']') {
                depth -= 1;
                if (depth === 0) arms.push(s.slice(start, i).trim());
            }
        }
        return arms;
    };
    // The text of one `| eval <name>=...` command of an arm, '' when absent.
    const cmd3c = (arm, head) => {
        const i = arm.indexOf(head);
        if (i === -1) return '';
        const j = arm.indexOf(' | ', i + head.length);
        return arm.slice(i, j === -1 ? arm.length : j);
    };
    const props = stanzas3c(conf3c('props.conf'));
    const saved = stanzas3c(conf3c('savedsearches.conf'));

    // (a) h1 + U5 --------------------------------------------------------------
    Object.keys(props).forEach((st) => {
        props[st].forEach((l) => {
            p3c(`[${st}] writes host again`,
                !/^FIELDALIAS-[^=]*=.*\b(?:AS|ASNEW)\s+host\s*$/i.test(l) && !/^EVAL-host\s*=/.test(l)
                    && !/^FIELDALIAS-[^=]*=.*\b(?:AS|ASNEW)\s+host\s+/i.test(l),
                `"${l.slice(0, 80)}" - host is the indexed LogServ host (build 378, h1)`);
        });
    });
    const ha = props['sap:hana:audit'] || [];
    p3c('[sap:hana:audit] lost the src_host alias',
        ha.indexOf('FIELDALIAS-src_host = audit_hostname AS src_host') !== -1,
        'the client host name (CSV field 9) is src_host, the twin of dest_host');
    p3c('[sap:hana:audit] EXTRACT-basic_fields requires the client fields again (U5)',
        key3c(props, 'sap:hana:audit', 'EXTRACT-basic_fields')
            .indexOf(';(?<client_ip>[^;]+)?;(?<audit_hostname>[^;]+)?;(?<session_id>[^;]+)?;(?<connection_id>[^;]+)?;') !== -1,
        'a record with no client (GRANT PRIVILEGE, DDL) must still parse');

    // (b) i1 ---------------------------------------------------------------------
    const ht = props['sap:hana:tracelogs'] || [];
    p3c('[sap:hana:tracelogs] aliases severity again (U39)',
        !ht.some((l) => /^FIELDALIAS-[^=]*=.*\bAS\s+severity\s*$/i.test(l)),
        'an alias runs before the EVALs, so it never saw hana_trace_severity');
    p3c('[sap:hana:tracelogs] hana_op_duration_ms is not the EVAL\'s alone',
        ht.some((l) => l.startsWith('EVAL-hana_op_duration_ms = '))
            && !ht.some((l) => /^EXTRACT-/.test(l) && l.indexOf('(?<hana_op_duration_ms>') !== -1),
        'the duration is the unit-normalised EVAL (usec / msec / sec); an EXTRACT beside it is the msec-only one');
    p3c('[sap:hana:tracelogs] the trace / backup line extractions are not anchored',
        key3c(props, 'sap:hana:tracelogs', 'EXTRACT-hana_trace_level').startsWith('^\\[')
            && key3c(props, 'sap:hana:tracelogs', 'EXTRACT-hana_backup_line').startsWith('^\\d{4}'),
        'unanchored, a continuation or backup.log line yields junk levels and components');

    // (c) e / f props ----------------------------------------------------------------
    const groups3c = (st) => new Set([].concat(...(props[st] || []).filter((l) => /^EXTRACT-/.test(l))
        .map((l) => (l.match(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g) || []).map((g) => g.slice(3, -1))))
        .concat((props[st] || []).map((l) => /^EVAL-([^\s=]+)\s*=/.exec(l)).filter(Boolean).map((m) => m[1])));
    const srF = groups3c('sap:saprouter');
    ['saprouter_target_addr', 'saprouter_target_service', 'saprouter_target_ip', 'saprouter_target_sid',
        'saprouter_fail_target_ip', 'saprouter_target_role', 'saprouter_target_instance'].forEach((f) => {
        p3c(`[sap:saprouter] lost ${f}`, srF.has(f), 'the saprouter edges, nodes and inventory arms read it');
    });
    const gwF = groups3c('sap:abap:gateway');
    ['gw_remgw_target', 'gw_remgw_service', 'gw_client_ip', 'gw_client_hostname', 'gw_client_tp', 'rfc_peer_port',
        'rfc_local_port'].forEach((f) => {
        p3c(`[sap:abap:gateway] lost ${f}`, gwF.has(f), 'the rfc edges and detail arms read it');
    });
    [
        ['EXTRACT-gw_function', '^(?:\\*{3}LOG\\s+\\w+=>\\s+)?(?<gw_function>Gw\\w+):'],
        ['EXTRACT-gw_remote_host', 'host\\s+(?<gw_remote_host>[a-zA-Z0-9._-]+)'],
        ['EXTRACT-gw_service', 'service\\s+(?<gw_service>\\w+)'],
        ['EXTRACT-rfc_peer_ip', 'P=(?<peer_ip>\\d+\\.\\d+\\.\\d+\\.\\d+)'],
        ['EXTRACT-rfc_local_ip', 'L=(?<local_ip>\\d+\\.\\d+\\.\\d+\\.\\d+)'],
    ].forEach(([k, v]) => {
        p3c(`[sap:abap:gateway] ${k} changed`, key3c(props, 'sap:abap:gateway', k) === v,
            'the abapnet rollup keys and the topology nodes / inventory read it: a new value re-keys their history');
    });
    const srRole = key3c(props, 'sap:saprouter', 'EVAL-saprouter_target_role');
    const srInst = key3c(props, 'sap:saprouter', 'EVAL-saprouter_target_instance');
    p3c('[sap:saprouter] a 3298 target reads as a dispatcher or carries an instance number',
        srRole.indexOf('saprouter_target_service=="3298","niping"') !== -1
            && srRole.indexOf('saprouter_target_service=="3298","niping"') < srRole.indexOf('"dispatcher"')
            && srInst.indexOf('saprouter_target_service!="3298"') !== -1 && srInst.indexOf('saprouter_target_service!="3299"') !== -1,
        '3298 is the niping test server and 3299 SAP Router: neither is an instance port');

    // (d) f: the rfc arms -----------------------------------------------------------------
    const PRED = '| eval rfc_in=if(isnotnull(gw_client_ip), 1, if(match(rfc_local_port, "^(33|48)\\d\\d$"), 1, 0))';
    const PEER_HEAD = '| eval rfc_peer_raw=';
    const PEER_END = '| where isnotnull(rfc_peer) AND rfc_peer!="" AND NOT cidrmatch("127.0.0.0/8", rfc_peer)';
    const CONN = '| eval rfc_conn=if(isnull(gw_remgw_target) AND isnull(gw_client_ip), '
        + 'peer_ip . ":" . coalesce(rfc_peer_port, "?") . "/" . coalesce(rfc_local_port, "?"), null())';
    const peerOf = (arm) => {
        const i = arm.indexOf(PEER_HEAD);
        const j = arm.indexOf(PEER_END, i);
        return i === -1 || j === -1 ? '' : arm.slice(i, j + PEER_END.length);
    };
    const rfcArms = [];
    [['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'],
        ['logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill']].forEach((pair) => {
        pair.forEach((n) => {
            const arms = arms3c(key3c(saved, n, 'search'));
            p3c(`[${n}] could not be split into its union arms`, arms.length > 4, `${arms.length} arms`);
            arms.filter((a) => a.indexOf('sourcetype=sap:abap:gateway') !== -1).forEach((a) => {
                p3c(`[${n}] a gateway arm counts lines as calls again`, a.indexOf('stats count as call_count') === -1,
                    'dev_rd records connections, not calls: an rfc edge counts connections (build 378, f)');
                p3c(`[${n}] a gateway arm reads ICM fields again`, a.indexOf('icm_program') === -1
                    && a.indexOf('icm_tasks') === -1, 'sap:abap:gateway carries neither');
                rfcArms.push({ n, a });
            });
        });
    });
    const eOut = rfcArms.filter((x) => x.n.indexOf('edges') !== -1 && x.a.indexOf('| where rfc_in==0 |') !== -1);
    const eIn = rfcArms.filter((x) => x.n.indexOf('edges') !== -1 && x.a.indexOf('| where rfc_in==1 |') !== -1);
    const dRfc = rfcArms.filter((x) => x.n.indexOf('detail') !== -1);
    p3c('the edges searches do not carry one outbound and one inbound rfc arm each',
        eOut.length === 2 && eIn.length === 2 && rfcArms.filter((x) => x.n.indexOf('edges') !== -1).length === 4,
        `${eOut.length} outbound, ${eIn.length} inbound of ${rfcArms.filter((x) => x.n.indexOf('edges') !== -1).length}`);
    p3c('the detail searches do not carry one rfc arm per metric each',
        dRfc.length === 6 && ['edge_op', 'edge_perf', 'edge_err'].every((m) =>
            dRfc.filter((x) => x.a.endsWith(`| eval metric="${m}"`)).length === 2),
        `${dRfc.length} rfc detail arms`);
    p3c('the rfc orientation predicate changed',
        rfcArms.length > 0 && rfcArms.every((x) => cmd3c(x.a, '| eval rfc_in=') === PRED),
        `expected exactly ${PRED} in every rfc arm (edges and detail): a local port 33NN / 48NN is the listener`);
    const peers = rfcArms.map((x) => peerOf(x.a));
    p3c('the rfc partner derivation differs between arms',
        peers.length > 0 && peers[0] !== '' && peers.every((p) => p === peers[0])
            && peers[0].indexOf('split(gw_remgw_target, "/H/"), -1)') !== -1 && peers[0].indexOf('lower(') !== -1,
        'one derivation (last /H/ hop, four octets of an IP, lower-cased short host) in the edges and detail arms');
    p3c('an rfc arm keeps loopback partners',
        rfcArms.length > 0 && rfcArms.every((x) => x.a.indexOf(PEER_END) !== -1),
        `expected ${PEER_END} in every rfc arm: a client on 127.0.0.1 would join unrelated SIDs through one node`);
    const conns = rfcArms.filter((x) => x.a.indexOf('rfc_conn') !== -1);
    p3c('a broken rfc connection is not keyed by both ports',
        conns.length === 6 && conns.every((x) => cmd3c(x.a, '| eval rfc_conn=') === CONN),
        `${conns.length} arms read rfc_conn; expected 6 (2 edges arms + edge_perf, x2) each with ${CONN}: on an`
        + ' outbound line the peer port is the remote listener, the same for every connection to it');
    const LOCAL_KEEP = ['| fillnull value="(none)" local_ip |', '| eval local_ip=if(local_ip=="(none)", null(), local_ip) |'];
    p3c('an rfc arm groups by an empty-string local_ip again',
        rfcArms.every((x) => !/fillnull value=""[^|]*\blocal_ip\b/.test(x.a) && x.a.indexOf('local_ip==""') === -1),
        'the stats keeps the connection records through a "(none)" placeholder, not an empty string');
    eOut.forEach((x) => {
        p3c(`[${x.n}] the outbound rfc arm lost its connection counts or its local_ip grain`,
            x.a.indexOf('dc(rfc_conn) as broken_count by sap_sid, rfc_peer_kind, rfc_peer, local_ip, _time') !== -1
            && x.a.indexOf('| eval call_count=closed_count+broken_count, error_count=broken_count |') !== -1
            && LOCAL_KEEP.every((t) => x.a.indexOf(t) !== -1)
            && x.a.indexOf('source_kind="sid"') !== -1 && x.a.indexOf('target_kind=rfc_peer_kind') !== -1,
            'calls = closed + distinct broken connections, errors = the broken ones, by local_ip (the key form)');
    });
    eIn.forEach((x) => {
        p3c(`[${x.n}] the inbound rfc arm lost its connection counts, its local_ip grain or its direction`,
            x.a.indexOf('dc(rfc_conn) as broken_count by sap_sid, rfc_peer, local_ip, _time') !== -1
            && x.a.indexOf('| eval call_count=session_count+broken_count, error_count=broken_count |') !== -1
            && LOCAL_KEEP.every((t) => x.a.indexOf(t) !== -1)
            && x.a.indexOf('source_kind="ip"') !== -1 && x.a.indexOf('target_kind="sid"') !== -1,
            'an inbound connection is the client IP -> the SID');
    });
    const RFC_IDS = '| eval source_id=if(rfc_in==1, substr(sha1("ip:" . rfc_peer), 1, 16), substr(sha1("sid:" . sap_sid), 1, 16))'
        + ' | eval target_id=if(rfc_in==1, substr(sha1("sid:" . sap_sid), 1, 16), substr(sha1(rfc_peer_kind . ":" . rfc_peer), 1, 16))';
    p3c('an rfc detail arm derives its scope other than the edges orient the edge',
        dRfc.length > 0 && dRfc.every((x) => x.a.indexOf(RFC_IDS) !== -1),
        'inbound ip -> sid, outbound sid -> partner kind, as the edges arms write source / target');

    // (e) e: saprouter ---------------------------------------------------------------------
    const SR_TGT = '| eval sr_target=coalesce(saprouter_target_ip, saprouter_fail_target_ip)'
        + ' | where isnotnull(sr_target) AND NOT cidrmatch("127.0.0.0/8", sr_target)';
    [['logserv_topology_aggregate_edges', 1], ['logserv_topology_backfill_edges', 1],
        ['logserv_topology_detail_aggregate', 3], ['logserv_topology_detail_backfill', 3]].forEach(([n, want]) => {
        const sr = arms3c(key3c(saved, n, 'search')).filter((a) => a.indexOf('sourcetype=sap:saprouter') !== -1);
        p3c(`[${n}] has ${sr.length} saprouter arm(s), expected ${want}`, sr.length === want, '');
        sr.forEach((a) => {
            p3c(`[${n}] a saprouter arm lost the 127.0.0.0/8 target filter`, a.indexOf(SR_TGT) !== -1,
                `expected ${SR_TGT} (cidrmatch is false on an absent value, hence isnotnull)`);
        });
        if (n.indexOf('edges') !== -1) {
            p3c(`[${n}] the saprouter arm lost its endpoint kinds`, sr.length === 1
                && sr[0].indexOf('source_kind="saprouter"') !== -1 && sr[0].indexOf('target_kind="ip"') !== -1
                && sr[0].indexOf('type="saprouter"') !== -1 && sr[0].indexOf('direction="client"') !== -1,
            'router host (kind saprouter, never folded into a SID) -> CONNECT TO target IP (U29 S2)');
        }
    });
    ['logserv_topology_aggregate_nodes', 'logserv_topology_backfill_nodes'].forEach((n) => {
        const s = key3c(saved, n, 'search');
        const arms = arms3c(s);
        p3c(`[${n}] lost the router host arm`, arms.some((a) => a.indexOf('sourcetype=sap:saprouter host=*') !== -1
            && a.endsWith('| eval canonical_kind="saprouter"')), 'U33 (a)');
        p3c(`[${n}] lost the CONNECT TO target arm or its loopback filter`, arms.some((a) =>
            a.indexOf('| rename saprouter_target_ip as canonical_value | eval canonical_kind="ip"') !== -1
            && a.indexOf('saprouter_target_ip=* | where NOT cidrmatch("127.0.0.0/8", saprouter_target_ip) |') !== -1),
        'U33 (b)');
        p3c(`[${n}] lost the ROUTER tag`, s.indexOf('canonical_kind == "saprouter", "ROUTER", 1==1, "EXT")') !== -1,
            'the router renders as its own SAP ROUTER partner node');
    });
    // Build 379: the inventory's tail, exactly, and the shape every arm feeds it.
    const INV_TAIL3C = '| stats sum(n) as n, max(last_seen) as last_seen by canonical_value, canonical_kind, resolved_sid'
        + ' | eval last_hour=floor(last_seen/3600)*3600'
        + ' | eventstats max(last_hour) as newest_hour by canonical_value, canonical_kind'
        + ' | where last_hour=newest_hour'
        + ' | eventstats max(n) as top_n by canonical_value, canonical_kind'
        + ' | where n=top_n'
        + ' | stats values(resolved_sid) as resolved_sids by canonical_value, canonical_kind'
        + ' | where mvcount(resolved_sids)=1 | eval resolved_sid = mvindex(resolved_sids, 0) | eval _key = canonical_value'
        + ' | eval updated_at = now() | fields _key, canonical_value, canonical_kind, resolved_sid, updated_at'
        + ' | outputlookup append=true logserv_topology_inventory';
    // A whole arm: its base search (no pipe), the router arm's loopback filter, then exactly these three commands -
    // a filter added before the stats would decide per arm again.
    const INV_ARM3C = new RegExp('^search `sap_logserv_idx_macro` [^|]+'
        + '(?: \\| where NOT cidrmatch\\("127\\.0\\.0\\.0/8", \\w+\\))?'
        + ' \\| stats count as n, max\\(_time\\) as last_seen by (\\w+), (\\w+)'
        + ' \\| eval canonical_value=\\1, canonical_kind="(?:ip|host)", resolved_sid=\\2'
        + ' \\| fields canonical_value, canonical_kind, resolved_sid, n, last_seen$');
    // The post-union tail: what follows the last arm (quote-aware, as arms3c).
    const tail3c = (spl) => {
        const s = spl.trim().replace(/^\|\s*union\s+/, '');
        let depth = 0;
        let inQ = false;
        let rest = -1;
        for (let i = 0; i < s.length; i += 1) {
            const ch = s[i];
            if (ch === '"') {
                let bs = 0;
                for (let j = i - 1; j >= 0 && s[j] === '\\'; j -= 1) bs += 1;
                if (bs % 2 === 0) inQ = !inQ;
            } else if (!inQ && ch === '[') {
                depth += 1;
            } else if (!inQ && ch === ']') {
                depth -= 1;
                if (depth === 0) rest = i + 1;
            }
        }
        return rest === -1 ? '' : s.slice(rest).trim();
    };
    ['logserv_topology_aggregate_inventory', 'logserv_topology_backfill_inventory'].forEach((n) => {
        const s = key3c(saved, n, 'search');
        const invArms = arms3c(s);
        p3c(`[${n}] lost the sapms<SID> arm or its loopback filter`, invArms.some((a) =>
            a.indexOf('saprouter_target_ip=* saprouter_target_sid=* | where NOT cidrmatch("127.0.0.0/8", saprouter_target_ip) |') !== -1
            && a.endsWith('| stats count as n, max(_time) as last_seen by saprouter_target_ip, saprouter_target_sid'
                + ' | eval canonical_value=saprouter_target_ip, canonical_kind="ip", resolved_sid=saprouter_target_sid'
                + ' | fields canonical_value, canonical_kind, resolved_sid, n, last_seen')),
        'U30: <ip>/sapms<SID> names the SID the target serves');
        p3c(`[${n}] tests the exact loopback 127.0.0.1`, s.indexOf('127.0.0.1') === -1, 'loopback is 127.0.0.0/8');
        const deciding = invArms.filter((a) => /mvcount\(|values\(/.test(a));
        p3c(`[${n}] an inventory arm decides on a SID by itself again`, invArms.length === 5 && deciding.length === 0,
            `${invArms.length} arms, ${deciding.length} with mvcount() / values(): an arm passes every (entity, SID) it saw,`
            + ' with its event count and newest event, and only the tail chooses, over all arms (build 379)');
        const unshaped = invArms.filter((a) => !INV_ARM3C.test(a));
        p3c(`[${n}] an inventory arm does not count events and the newest event per entity and SID`,
            invArms.length > 0 && unshaped.length === 0,
            'expected every arm to be its base search (the router arm: then its loopback where), then exactly "| stats'
            + ' count as n, max(_time) as last_seen by <entity>, <sid> | eval canonical_value=<entity>, canonical_kind=...,'
            + ` resolved_sid=<sid> | fields canonical_value, canonical_kind, resolved_sid, n, last_seen"; found ${unshaped.join(' || ')}`);
        const invTail = tail3c(s);
        p3c(`[${n}] the inventory tail no longer prefers each entity's most recent SID`, invTail === INV_TAIL3C,
            `expected "${INV_TAIL3C}", found "${invTail}" - the SIDs of the entity's most recent hour (epoch arithmetic),`
            + ' then the most events, an exact tie no row; the first command stays an order-free stats so the staged'
            + ' Settings backfill equals the union (utils/backfillPlan.ts)');
        p3c(`[${n}] formats time`, s.indexOf('strftime') === -1,
            'gate 3s does not reach the inventory stanzas (their names end in _inventory): the hour is'
            + ' floor(last_seen/3600)*3600 - strftime renders in the dispatching user\'s time zone');
    });

    // (f) i1 knock-on: the null-safe hana_tenant warning ----------------------------------------
    ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'].forEach((n) => {
        const s = key3c(saved, n, 'search');
        p3c(`[${n}] the hana_tenant warning_count is not null-safe`,
            s.indexOf('AND (isnull(hana_trace_severity) OR (hana_trace_severity!="ERROR" AND hana_trace_severity!="FATAL")), 1, 0))) as warning_count') !== -1
            && s.indexOf('AND hana_trace_severity!="ERROR" AND hana_trace_severity!="FATAL", 1, 0)') === -1,
            'record files have no severity (i1); a != test on an absent value is false, so slow hdbcons commands would stop counting');
    });

    // (g) ES -------------------------------------------------------------------------------------
    const ANOM_N = 'splunk_sap_logserv_es_anomaly_topology_edge_volume';
    const anom = key3c(saved, ANOM_N, 'search');
    p3c('the edge anomaly baselines by fields edge rows do not carry',
        anom.indexOf('stdev(call_count) AS baseline_stdev by id, type') !== -1 && anom.indexOf('by source, target, type') === -1,
        'edge rows carry id and type (source_id / target_id), never source / target (U37)');
    p3c('the edge anomaly no longer names the edge',
        anom.indexOf('| eval source=mvindex(spath(spl_filter_clauses, "{}.value"), 0), '
            + 'target=mvindex(spath(spl_filter_clauses, "{}.value"), 1)') !== -1,
        'every edge arm writes its source value first and its target value second into spl_filter_clauses');
    // Every field the stanza's notable / risk / suppression settings read must exist on a result row:
    // an edge row's own fields (collections.conf) or a field the search writes (eval / AS).
    const coll = stanzas3c(conf3c('collections.conf'))['logserv_topology_edges'] || [];
    const rowFields = new Set(['_key'].concat(coll.map((l) => /^field\.([A-Za-z0-9_]+)\s*=/.exec(l)).filter(Boolean).map((m) => m[1])));
    let fm;
    const defRe = /(?:\beval\s+|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
    while ((fm = defRe.exec(anom)) !== null) rowFields.add(fm[1]);
    const asRe = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    while ((fm = asRe.exec(anom)) !== null) rowFields.add(fm[1]);
    const used = new Set();
    (saved[ANOM_N] || []).filter((l) => l.startsWith('action.')).forEach((l) => {
        const v = l.slice(l.indexOf(' = ') + 3);
        (v.match(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g) || []).forEach((t) => used.add(t.slice(1, -1)));
        if (l.startsWith('action.notable.param.nes_fields = ')) v.split(',').map((s) => s.trim()).filter(Boolean).forEach((f) => used.add(f));
        (v.match(/"risk_object_field"\s*:\s*"([^"]+)"/g) || []).forEach((t) => used.add(/:\s*"([^"]+)"/.exec(t)[1]));
    });
    const missing3c = Array.from(used).filter((f) => !rowFields.has(f));
    p3c('the edge anomaly\'s notable / risk settings read fields its rows do not carry',
        coll.length > 0 && used.size > 0 && missing3c.length === 0,
        `missing: ${missing3c.join(', ') || '(none)'}; read: ${Array.from(used).join(', ')} - a notable naming no edge, a risk event without a risk object`);
    ['splunk_sap_logserv_es_hana_failed_connect_spike', 'splunk_sap_logserv_es_after_hours_admin_data_access'].forEach((n) => {
        p3c(`[${n}] no longer lists the client hosts`, key3c(saved, n, 'search').indexOf('values(src_host) AS src_hosts') !== -1,
            'host is the HANA host (h1, U4); the client machines are src_hosts');
    });

    console.log(`check-diagnostics: 3conf build-378 conf contract (no props stanza writes host; src_host + optional client`
        + ` fields; tracelogs anchored, no severity alias; ${eOut.length + eIn.length} rfc edges arms + ${dRfc.length} rfc`
        + ' detail arms on one predicate and one partner derivation, loopback dropped, broken connections keyed by both ports;'
        + ' saprouter arms 1/3 per stanza with the 127.0.0.0/8 filter, 3298 = niping; null-safe hana_tenant warning;'
        + ` anomaly by id, type naming source / target (${used.size} notable / risk fields resolved); src_hosts on the HANA correlations)`);
}

// --- 3tu: the topology UI's SAP Router type and RFC connection captions (build 378) -
//
// Build 378, items e and f, UI side (session 156; decisions U29 S2, U30, U32 U1,
// U37). The behaviour is held by utils/topologyTypes.consistency-test.ts (the
// type list, the shared colour token and its perceptual distance in both modes,
// the saved-layout union rule, retargetEndpoint, the per-type pane text, the
// conf's literal types / kinds / clause fields / tags against the UI). These
// pins hold the WIRING that suite cannot see - the .tsx call sites:
//  (a) loading a saved layout goes through restoreEnabledTypes with the layout's
//      enabled AND known types, never a verbatim restore of the saved list
//      (which hides every type added after the save - the SAP Router edges on
//      every pre-378 layout); saving records the known types.
//  (b) persistence.ts round-trips the known types (known_types_json).
//  (c) the right pane reads the per-type colour and name from edgeStyle (one
//      SAP Router token for the canvas and the badge - no second switch), and
//      its Edge Details nouns from edgeMeasureLabels / edgeOperationsNoun /
//      edgePerformanceCaption: no literal "Calls in window", "ABAP programs"
//      or "icm_tasks distribution" left in its code (comments may explain).
//      The Operations donut counts in the edge's unit: its wedges carry
//      unit: measures.unit, the wedge hover text reads the datum's unit and
//      the centre word the wedges' unit (donutCentreUnit), no literal "calls"
//      under the centre. (The tooltip's existence stays 3o's pin.)
//  (d) useTopologyData retargets through retargetEndpoint (the router is never
//      folded into a SID), keeps no private copy of the type map or the clause
//      classifier, tags nodes through fixedTagForKind / isFixedTag, and leaves
//      router endpoints out of the "% endpoints resolved to SID" count.
//  (e) the health ring's failure rate is failureRate (clamped; an edge with
//      failures and no routed connection is 100 % failed, not 0 %).
//  (f) the SAP Router colour is ONE constant: edgeColor and splTypeColorToken
//      both return SAPROUTER_EDGE_TOKEN for 'saprouter'.
//  (g) a SAP Router node keeps the partner square (no new styled variant - 3q
//      counts three group outlines) with its own glyph and tooltip kind.
//  (h) build 380: the node pane's partner donuts name what they count from
//      their edge types (combinedMeasureUnit) - caption, wedges and centre -
//      and its hourly chart reads "Count / hr" (pinned under (c)).
{
    const H3TU = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const home3tu = (rel) => fs.readFileSync(path.join(H3TU, rel), 'utf8').replace(/\r\n/g, '\n');
    // Code only: block comments, line comments (not `://`) and JSX comments go.
    const code3tu = (t) => t
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const p3tu = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3tu ${label}: ${detail}`);
            failed = true;
        }
    };

    // (a) the layout load / save wiring ------------------------------------
    const integ3tu = code3tu(home3tu('dashboards/IntegrationTopology.tsx'));
    p3tu('a loaded layout no longer goes through restoreEnabledTypes',
        /restoreEnabledTypes\(\s*layout\.enabledTypes,\s*layout\.knownTypes,\s*ALL_INTEGRATION_TYPES,?\s*\)/.test(integ3tu),
        'a saved filter list restored verbatim hides every integration type added after the save');
    const setters3tu = [];
    const setRe3tu = /setEnabledTypes\(([^\n]*)/g;
    let sm3tu;
    while ((sm3tu = setRe3tu.exec(integ3tu)) !== null) setters3tu.push(sm3tu[1]);
    const allowed3tu = ['(prev) =>', 'enable ? new Set(ALL_INTEGRATION_TYPES) : new Set()',
        'new Set<IntegrationType>(restoredTypes)'];
    const odd3tu = setters3tu.filter((a) => !allowed3tu.some((p) => a.startsWith(p)));
    p3tu('a loaded layout restores its enabled types verbatim again',
        !/layout\.enabledTypes\.filter\(/.test(integ3tu) && odd3tu.length === 0 && setters3tu.length === 3,
        `only the type toggle, All / None and the restoreEnabledTypes result may set the filter; found ${
            JSON.stringify(odd3tu)} (${setters3tu.length} setter call(s))`);
    p3tu('a saved layout no longer records the integration types it knows',
        /knownTypes:\s*knownTypesArr,[\s\S]*?knownTypes:\s*knownTypesArr,/.test(integ3tu)
        && /const knownTypesArr: string\[\] = ALL_INTEGRATION_TYPES\.slice\(\);/.test(integ3tu),
        'both the KV save payload and the in-memory saved layout must carry knownTypes');

    // (b) persistence round-trips the known types --------------------------
    const pers3tu = code3tu(home3tu('topology/persistence.ts'));
    p3tu('persistence.ts no longer writes known_types_json',
        /known_types_json:\s*JSON\.stringify\(layout\.knownTypes\)/.test(pers3tu)
        && /knownTypes:\s*payload\.knownTypes,/.test(pers3tu),
        'a layout saved now would load as a pre-378 one and re-enable a type the user switched off');
    p3tu('persistence.ts no longer reads known_types_json',
        /safeParseJson<unknown>\(rec\.known_types_json\)/.test(pers3tu)
        && /knownTypes:\s*Array\.isArray\(knownTypes\)/.test(pers3tu),
        'the recorded known types never reach restoreEnabledTypes');

    // (c) the right pane delegates ------------------------------------------
    const side3tu = code3tu(home3tu('components/topology/TopologyRightSidebar.tsx'));
    p3tu('the right pane colours edge types itself again',
        /const edgeTypeColor = \(splType: string \| undefined\): string =>\s*logservTheme\.colors\[splTypeColorToken\(splType\)\];/.test(side3tu)
        && /const edgeTypeLabel = \(splType: string \| undefined\): string => splTypeLabel\(splType\);/.test(side3tu)
        && !/case 'saprouter'/.test(side3tu),
        'a second per-type switch lets the SAP Router badge and the canvas edge drift apart');
    p3tu('the Edge Details nouns are hard-coded again',
        /const measures = edgeMeasureLabels\(splType\);/.test(side3tu)
        && /\{measures\.countRow\}/.test(side3tu) && /\{measures\.errorRow\}/.test(side3tu)
        && /\$\{measures\.unit\}/.test(side3tu)
        && (side3tu.match(/\{measures\.okLegend\}/g) || []).length === 2
        && (side3tu.match(/\{measures\.errLegend\}/g) || []).length === 2,
        'an RFC edge would read "calls" for connections, a SAP Router edge "errors" for failed connections');
    const stale3tu = /'Calls in window'|>Calls in window<|'ABAP programs'|'icm_tasks distribution'|'Successful calls'/.exec(side3tu);
    p3tu('the right pane carries a pre-378 per-type caption in its code', !stale3tu,
        `found ${stale3tu ? stale3tu[0] : ''} - the per-type text lives in topology/edgeStyle.ts`);
    p3tu('the edge Operations donut counts "calls" again',
        /<DonutChart\s+label="Top entities on this edge"\s+data=\{edgeData\.operations\.map\(\(op, i\) => \(\{[^}]*\bcalls: op\.count,\s*unit: measures\.unit,/.test(side3tu)
        && !/>calls<\/text>/.test(side3tu)
        && />\{centre \?\? donutCentreUnit\(unit\)\}<\/text>/.test(side3tu)
        && /const unit = data\.find\(\(d\) => d\.unit\)\?\.unit \?\? 'calls';/.test(side3tu)
        && /\$\{d\.calls\.toLocaleString\(\)\} \$\{d\.unit \?\? 'calls'\} \(/.test(side3tu),
        'an RFC or SAP Router Operations donut would print "calls" for connections in its centre and hover text');
    // (h) build 380: the node pane's two partner donuts count in their
    // direction's unit too - combinedMeasureUnit over the edge types
    // splitPartners records; the caption names it, the wedges carry it, the
    // centre word comes with it; the hourly chart reads "Count / hr".
    p3tu('the node pane donuts count "calls" again',
        /const inboundMeasure = React\.useMemo\(\s*\(\) => combinedMeasureUnit\(partnerSplit\.inboundTypes\),/.test(side3tu)
        && /const outboundMeasure = React\.useMemo\(\s*\(\) => combinedMeasureUnit\(partnerSplit\.outboundTypes\),/.test(side3tu)
        && /buildDonutData\(partnerSplit\.inbound, inboundMeasure\.unit\)/.test(side3tu)
        && /buildDonutData\(partnerSplit\.outbound, outboundMeasure\.unit\)/.test(side3tu)
        && /\$\{calls\.toLocaleString\(\)\} \$\{measure\.unit\}`/.test(side3tu)
        && /<DonutChart data=\{data\} label=\{title\} centre=\{measure\.centre\} \/>/.test(side3tu)
        && (side3tu.match(/measure=\{(in|out)boundMeasure\}/g) || []).length === 2
        && !/calls\.toLocaleString\(\)\} calls`/.test(side3tu)
        && !/>Calls \/ hr/.test(side3tu),
        'a node whose partners talk RFC or through the SAP Router would read "calls" for connections');
    p3tu('the Operations / Performance captions no longer come from edgeStyle',
        /edgeOperationsNoun\(splType\)/.test(side3tu) && /edgePerformanceCaption\(splType\)/.test(side3tu),
        'the RFC tabs would name icm_program / icm_tasks again');
    p3tu('the pane\'s error rate is no longer clamped',
        /failureRate\(selectedEdge\.callCount, selectedEdge\.errorCount \?\? 0\)/.test(side3tu),
        'a SAP Router edge whose failures outnumber its routed connections would show over 100 %');

    // (d) useTopologyData --------------------------------------------------
    const topo3tu = code3tu(home3tu('hooks/useTopologyData.ts'));
    p3tu('useTopologyData no longer retargets through retargetEndpoint',
        /const retarget = \(nodeId: string\): string => retargetEndpoint\(/.test(topo3tu),
        'an inline rule can fold the SAP Router host into the SID that runs on the same VM');
    p3tu('useTopologyData keeps a private copy of the type map or the clause classifier',
        !/const splTypeToIntegrationType\s*=/.test(topo3tu) && !/const clauseFieldToKind\s*=/.test(topo3tu)
        && /import \{ splTypeToIntegrationType \} from '\.\.\/topology\/edgeStyle';/.test(topo3tu),
        'a copy the suite cannot see would drop saprouter (drawn as RFC) or its clause fields');
    p3tu('useTopologyData no longer tags nodes through fixedTagForKind / isFixedTag',
        (topo3tu.match(/fixedTagForKind\(/g) || []).length === 2 && /isFixedTag\(n\.tag\)/.test(topo3tu),
        'a router whose host name contains "hdb" or "ora" would be drawn as a database');
    p3tu('router endpoints count against "% endpoints resolved to SID" again',
        /if \(nodeIdToCanonical\.get\(id\)\?\.kind === 'saprouter'\) return;\s*totalEndpoints \+= 1;/.test(topo3tu),
        'a router is never resolved to a SID by design, so it would read as an inventory gap');

    // (e) the health ring ----------------------------------------------------
    p3tu('the health ring no longer uses failureRate',
        /const rate = failureRate\(total, errs\);/.test(integ3tu) && !/total > 0 \? errs \/ total : 0/.test(integ3tu),
        'an edge with failed connections and no routed one would ring green');

    // (f) one colour constant -----------------------------------------------
    const es3tu = code3tu(home3tu('topology/edgeStyle.ts'));
    p3tu('the SAP Router colour is no longer one constant',
        /case 'saprouter':\s*return c\[SAPROUTER_EDGE_TOKEN\];/.test(es3tu)
        && /case 'saprouter':\s*return SAPROUTER_EDGE_TOKEN;/.test(es3tu)
        && (es3tu.match(/export const SAPROUTER_EDGE_TOKEN = '[A-Za-z]+' as const;/g) || []).length === 1,
        'the canvas edge and the pane badge must read the same token');

    // (g) the router node ----------------------------------------------------
    const pn3tu = code3tu(home3tu('components/topology/nodeTypes/PartnerNode.tsx'));
    p3tu('a SAP Router node lost its glyph or tooltip kind',
        /const isRouter = d\.tag === 'ROUTER';/.test(pn3tu)
        && /kind=\{isRouter \? 'SAP Router' : 'Remote partner'\}/.test(pn3tu)
        && /\{isRouter \? '[^']+' : '⬢'\}/.test(pn3tu),
        'the router would render as an unnamed partner square');

    console.log('check-diagnostics: 3tu topology UI pinned (saved layouts restore through restoreEnabledTypes'
        + ' with known types, one SAP Router colour token, the pane\'s per-type text from edgeStyle'
        + ' and the Operations donut in the edge\'s unit,'
        + ' retargetEndpoint keeps routers unfolded, failureRate on the ring)');
}

// --- 3o: the node panel's claims, derived from the conf and the real tokens -
//
// Two things the .ts suite cannot check, both of which the panel now ASSERTS
// to a customer:
//
//  (a) "per-host rows are always inbound". That is true only because canonical
//      kind `host` never appears as an edge SOURCE in the shipped conf. It is a
//      property of the SPL, not of the UI, so it is derived from the SPL — and
//      if an arm ever emits source_kind="host" the outbound host row becomes
//      reachable and the copy has to be revisited before it ships.
//  (b) "the legend can be read". Palette cycling that wraps to a
//      near-identical shade satisfies string inequality while failing the
//      legend's only purpose, so the check is perceptual and its threshold is
//      DERIVED from the base palette rather than invented: cycling may not make
//      the colours a customer sees together less discriminable than the set the
//      app already ships.
{
    const SAVEDSEARCHES = path.resolve(
        __dirname,
        '../src/main/resources/splunk/default/savedsearches.conf',
    );
    const H = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const src = (rel) => fs.readFileSync(path.join(H, rel), 'utf8');
    const pin = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: ${label}: ${detail}`);
            failed = true;
        }
    };

    // (a) the endpoint-kind grammar --------------------------------------
    const conf = fs.readFileSync(SAVEDSEARCHES, 'utf8');
    const stanzas = {};
    let current = null;
    for (const raw of conf.split('\n')) {
        const m = /^\[(.+)\]\s*$/.exec(raw.trim());
        if (m) {
            current = m[1];
            stanzas[current] = [];
        } else if (current) {
            stanzas[current].push(raw);
        }
    }
    const EDGE_STANZAS = ['logserv_topology_aggregate_edges', 'logserv_topology_backfill_edges'];
    const missing = EDGE_STANZAS.filter((n) => !stanzas[n]);
    if (missing.length > 0) {
        console.error(`check-diagnostics: missing edge stanza(s): ${missing.join(', ')}`);
        failed = true;
    } else {
        const kinds = { source: new Set(), target: new Set() };
        let occurrences = 0;
        EDGE_STANZAS.forEach((n) => {
            const body = stanzas[n].join('\n');
            const re = /\b(source|target)_kind\s*=\s*"([a-z_]+)"/g;
            let m;
            while ((m = re.exec(body)) !== null) {
                // Skip the commented SPL drafts these stanzas keep above them:
                // a mutation landing in a comment must not read as covered.
                const lineStart = body.lastIndexOf('\n', m.index) + 1;
                if (body.slice(lineStart, m.index).trim().startsWith('#')) continue;
                kinds[m[1]].add(m[2]);
                occurrences += 1;
            }
            // Build 378: an arm may set a kind from a field - the outbound rfc
            // arm's target_kind=rfc_peer_kind is "ip" or "host" (a remote gateway
            // host). Resolve it from that arm's own `eval <field>=if(..., "a", "b")`;
            // an unresolvable one fails, so no kind reaches the edge rows unseen.
            body.split('\n').filter((l) => !l.trim().startsWith('#')).forEach((line) => {
                line.split(/\]\s*\[search/).forEach((arm) => {
                    const dre = /\b(source|target)_kind\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;
                    let dm;
                    while ((dm = dre.exec(arm)) !== null) {
                        const def = new RegExp(`\\b${dm[2]}=if\\(.*?,\\s*"([a-z_]+)",\\s*"([a-z_]+)"\\)`).exec(arm);
                        if (!def) {
                            console.error(`check-diagnostics: [${n}] sets ${dm[1]}_kind from ${dm[2]}, whose values `
                                + 'cannot be read from the arm - the endpoint-kind grammar would be unchecked');
                            failed = true;
                        } else {
                            kinds[dm[1]].add(def[1]);
                            kinds[dm[1]].add(def[2]);
                            occurrences += 1;
                            if ([def[1], def[2]].indexOf('host') !== -1 && /direction\s*=\s*"bidi"/.test(arm)) {
                                console.error(`check-diagnostics: [${n}] has an arm emitting direction="bidi" with a `
                                    + 'host endpoint (set from a field)');
                                failed = true;
                            }
                        }
                    }
                });
            });
        });
        if (occurrences === 0) {
            console.error('check-diagnostics: no endpoint kinds found in the edge stanzas');
            failed = true;
        }
        if (kinds.source.has('host')) {
            console.error(
                'check-diagnostics: an edge arm now emits source_kind="host" — a host endpoint '
                + 'can be an edge SOURCE, so the node panel\'s "per-host rows are always inbound" '
                + 'copy and the outbound branch of buildNodeTraffic must be re-reviewed',
            );
            failed = true;
        }
        if (!kinds.target.has('host')) {
            console.error(
                'check-diagnostics: no edge arm emits target_kind="host" — the Hosts tab\'s '
                + 'per-host traffic rows can never be produced',
            );
            failed = true;
        }
        // The panel says every per-host row is inbound. A host endpoint on an
        // arm stored `direction="bidi"` would make that false too, from the
        // other end: buildNodeTraffic assigns `bidirectional` to BOTH sides of
        // a bidi group, so such an arm produces a host row that is not inbound.
        EDGE_STANZAS.forEach((n) => {
            stanzas[n].forEach((line) => {
                if (line.trim().startsWith('#')) return;
                // Arms are one per bracketed subsearch on a single conf line;
                // split so a direction and a kind from DIFFERENT arms cannot
                // be read as belonging together.
                line.split(/\]\s*\[search/).forEach((arm) => {
                    if (!/direction\s*=\s*"bidi"/.test(arm)) return;
                    if (/(?:source|target)_kind\s*=\s*"host"/.test(arm)) {
                        console.error(
                            `check-diagnostics: [${n}] has an arm emitting direction="bidi" with a `
                            + 'host endpoint — a per-host traffic row would then be bidirectional, '
                            + 'falsifying the Hosts tab\'s "always inbound" copy',
                        );
                        failed = true;
                    }
                });
            });
        });
        console.log(
            `check-diagnostics: edge endpoint kinds derived from conf (source: ${
                Array.from(kinds.source).sort().join('/')}; target: ${
                Array.from(kinds.target).sort().join('/')})`,
        );
    }

    // (b) palette cycling against the REAL mode tokens ---------------------
    const sidebar = src('components/topology/TopologyRightSidebar.tsx');
    const paletteBody = /const partnerPalette = \(c: ColorTokens\): string\[\] => \[([^\]]*)\]/
        .exec(sidebar);
    if (!paletteBody) {
        console.error('check-diagnostics: cannot find the partner palette in the sidebar');
        failed = true;
    } else {
        const order = paletteBody[1]
            .split(',')
            .map((s) => s.trim().replace(/^c\./, ''))
            .filter((s) => s.length > 0);
        if (order.indexOf('textMuted') !== -1) {
            console.error(
                'check-diagnostics: textMuted is back in the donut palette — it is the SAME hex '
                + 'in both modes, so shading it buries it in the dark panel and washes it out on white',
            );
            failed = true;
        }
        const tokensSrc = fs.readFileSync(path.join(H, 'styles/magneticTokens.ts'), 'utf8');
        // Keyed by NAME, not by position: DARK_COLORS is declared FIRST in the
        // file and carries no type annotation, so a positional read would have
        // checked the light palette while calling it dark.
        const readTokens = (name) => {
            const re = new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`);
            const m = re.exec(tokensSrc);
            if (!m) return null;
            const map = {};
            const tokRe = /^\s{4}(\w+):\s*'(#[0-9a-fA-F]{6})'/gm;
            let tm;
            while ((tm = tokRe.exec(m[1])) !== null) map[tm[1]] = tm[2];
            return map;
        };
        const modes = [readTokens('LIGHT_COLORS'), readTokens('DARK_COLORS')];
        if (modes.some((m) => !m || Object.keys(m).length === 0)) {
            console.error('check-diagnostics: cannot read LIGHT_COLORS / DARK_COLORS from magneticTokens.ts');
            failed = true;
        } else {
            const pfMod = loadTs(path.join(H, 'topology/panelFacts'));
            const labels = ['light', 'dark'];
            modes.forEach((map, i) => {
                const palette = order.map((k) => map[k]);
                const unresolved = order.filter((k) => !map[k]);
                if (unresolved.length > 0) {
                    console.error(
                        `check-diagnostics: palette token(s) not found in the ${labels[i]} tokens: ${unresolved.join(', ')}`,
                    );
                    failed = true;
                    return;
                }
                const baseMin = pfMod.minPairwiseDistance(palette);
                // (i) The window the palette design promises full pairwise
                //     separation over. The legend itself lists EVERY partner —
                //     it is not capped — so beyond this window the guarantee
                //     weakens to (ii), which is what a reader scanning a long
                //     list actually relies on.
                const seen = [];
                for (let k = 0; k < pfMod.PALETTE_FULL_SEPARATION_ROWS; k += 1) {
                    seen.push(pfMod.partnerColorAt(palette, k, labels[i]));
                }
                const seenMin = pfMod.minPairwiseDistance(seen);
                if (seenMin < baseMin - 1e-6) {
                    console.error(
                        `check-diagnostics: ${labels[i]} palette cycling is LESS discriminable than the `
                        + `base set (${seenMin.toFixed(1)} < ${baseMin.toFixed(1)}) — a shaded wedge has `
                        + 'landed on another wedge\'s colour',
                    );
                    failed = true;
                }
                // (ii) Across the whole wedge budget: no colour may REPEAT, and
                //      neighbouring wedges — the pair a reader actually compares
                //      on the ring — must stay separable. Demanding a full
                //      pairwise minimum at this N is unachievable and would
                //      force a palette redesign this change does not warrant.
                //      The budget deliberately spans several cycles: a shade
                //      schedule that clamps produces identical colours from the
                //      cycle it saturates, which a three-cycle window misses.
                const WEDGE_BUDGET = 40;
                const cycled = [];
                for (let k = 0; k < WEDGE_BUDGET; k += 1) {
                    cycled.push(pfMod.partnerColorAt(palette, k, labels[i]));
                }
                if (new Set(cycled).size !== cycled.length) {
                    console.error(
                        `check-diagnostics: ${labels[i]} palette cycling repeats a colour within `
                        + `${WEDGE_BUDGET} wedges — the shade schedule has saturated`,
                    );
                    failed = true;
                }
                let adjMin = Infinity;
                for (let k = 1; k < cycled.length; k += 1) {
                    adjMin = Math.min(adjMin, pfMod.colorDistance(cycled[k - 1], cycled[k]));
                }
                // ABSOLUTE floor, not `>= baseMin` (changed 2026-09-20, session 129,
                // plan v0.2 Phase 6; user-ratified).
                //
                // The old bar compared two quantities that move in OPPOSITE
                // directions as a palette improves: raising the base colours'
                // separation raises baseMin, while the shade schedule compresses
                // every colour toward black/white as the cycle deepens (factor
                // ~0.44 by cycle 4), so adjMin barely moves. A well-separated
                // palette therefore FAILS a bar that a poorly-separated one
                // clears -- the guard rewarded the wrong thing. Measured:
                //
                //   palette            baseMin   adjMin
                //   Harbor  dark          46.0     52.7   passed (46.0 <= 52.7)
                //   Harbor  light         43.2     57.5   passed
                //   scaffold dark         89.7     53.4   would FAIL on 89.7
                //   scaffold light        80.7     48.7   would FAIL on 80.7
                //
                // The scaffold palette is strictly better separated at the base
                // and comparable at adjacency; only the relative bar objected.
                // 40 is anchored to the palette that actually shipped for months
                // -- below Harbor's own baseMin (43.2 / 46.0), and below every
                // adjMin measured above -- so it still catches a shade schedule
                // that genuinely collapses, which is what this check is for.
                const ADJ_FLOOR = 40;
                if (adjMin < ADJ_FLOOR - 1e-6) {
                    console.error(
                        `check-diagnostics: ${labels[i]} adjacent wedges are not separable `
                        + `(${adjMin.toFixed(1)} < ${ADJ_FLOOR}) — the shade schedule has collapsed; `
                        + `base palette separation is ${baseMin.toFixed(1)}`,
                    );
                    failed = true;
                }
            });
            console.log(
                `check-diagnostics: donut palette cycling checked against both mode token sets (${order.length} base colours)`,
            );
        }
    }

    // (c) source pins the behavioural suite cannot see --------------------
    const topo = src('hooks/useTopologyData.ts');
    pin('the traffic accumulator no longer reads the post-filter groups',
        /const survivingGroups = Array\.from\(edgeMap\.values\(\)\)\s*\n\s*\.filter\(\(agg\) => agg\.retargetedSource !== agg\.retargetedTarget\)/.test(topo)
        // The coupling that matters is which ARRAY feeds it: `survivingGroups`,
        // not `edgeMap.values()`. A pin that only checks the declaration exists
        // survives the substitution exactly.
        && /const trafficGroups: TrafficEdgeGroup\[\] = survivingGroups\.map\(/.test(topo)
        && /buildNodeTraffic\(\s*\n?\s*trafficGroups/.test(topo),
        'self-loop rows would be counted, so the Hosts tab would out-sum Total calls');
    // ALL member rows, not the group's representative row. `rows: [agg.row]`
    // is the pre-321 first-row-only shape: the traffic table would then count
    // roughly one hourly bucket per edge, and because the reconciliation
    // sentence self-suppresses when the sums disagree, nothing would say so.
    pin('the traffic groups no longer carry every member row',
        /rows: agg\.rows,/.test(topo),
        'a representative row would make the traffic table a fraction of the real volume, silently');
    pin('the attribution record is no longer keyed by node id',
        /nodeIdToCanonical\.forEach\(\(canonical, id\) => \{/.test(topo)
        && topo.indexOf('endpointAttribution[id] = {') > 0,
        'a value-keyed record would be looked up by label and fabricate a verdict');

    pin('the OTHER bucket is back in the partner donut',
        sidebar.indexOf('OTHER (') === -1,
        'every partner must keep its own wedge and its own count');
    // The legend lists EVERY partner (user directive, build 322 follow-up).
    // A re-introduced cap would silently drop endpoints from a panel whose
    // whole purpose is naming them.
    pin('the partner legend is capped again',
        /\{data\.map\(\(d\) => \{/.test(sidebar) && sidebar.indexOf('planLegend') === -1,
        'the legend must render the full data array, with no remainder row');
    // The tooltip is the only place the EXACT share is stated, and the wedge
    // angle is explicitly approximate — so losing it loses the number.
    pin('the donut wedges no longer carry a tooltip',
        /<title>\{wedgeTooltip\(d, total\)\}<\/title>/.test(sidebar)
        && /const wedgeTooltip = \(d: DonutDatum, total: number\): string/.test(sidebar),
        'hovering a slice must give its endpoint, exact count and share');
    pin('the ownership section is no longer gated on canonical kind',
        /const isSidNode = selectedAttribution\?\.kind === 'sid'/.test(sidebar),
        'a tenant database shares its label with an application SID, and on a partner node the '
        + 'rows are the hosts at the FAR end — badging either states the opposite of the truth');
    // The declaration pin cannot see the USE site changing, and the badge is
    // the claim: dropping the gate there puts "owner: XCP" on every row of a
    // partner node, two lines under a note saying no ownership is claimed.
    pin('the Hosts-row ownership badge is no longer gated',
        /const owner = isSidNode\s*\n?\s*\?\s*ownershipText\(classifyHostOwnership\(/.test(sidebar),
        'the badge would render on nodes where it states the opposite of the truth');
    // Likewise for the lookup KEY: the record is id-keyed, so a label lookup
    // misses silently and every badge disappears rather than misreporting.
    pin('the donut badge no longer looks the endpoint up by node id',
        /endpointAttribution\[p\.id\]/.test(sidebar)
        && /endpointAttribution\[selectedNode\.id\]/.test(sidebar),
        'a label-keyed lookup into an id-keyed record misses, silently removing every badge');
    pin('the Hosts caption no longer uses the pre-cap total',
        /const hostsTruncated = hostsTotal > hostsShown/.test(sidebar)
        && sidebar.indexOf('busiest of') > 0,
        'the caption would present the read\'s cap as the host count');

    // The Hosts read: presence is not the property that matters. `host_total`
    // is only PRE-cap if the eventstats runs BEFORE the head, and it only
    // reaches the panel if the trailing projection keeps it. Either
    // substitution silently makes the caption print the cap as the truth.
    const searches = src('topology/searches.ts');
    const hostsBody = /export const SEARCH_NODE_HOSTS[\s\S]*?`\.trim\(\);/.exec(searches);
    if (!hostsBody) {
        pin('SEARCH_NODE_HOSTS could not be located', false, 'the Hosts read changed shape');
    } else {
        const body = hostsBody[0];
        const iEventstats = body.indexOf('eventstats dc(host) as host_total');
        const iHead = body.indexOf('head ${NODE_HOSTS_LIMIT}');
        pin('the Hosts read stopped carrying its pre-cap total',
            iEventstats > 0 && iHead > 0,
            'without host_total the panel cannot know it was truncated');
        pin('the pre-cap total is no longer computed BEFORE the cap',
            iEventstats > 0 && iHead > 0 && iEventstats < iHead,
            'an eventstats after the head counts only the capped rows, so host_total equals the cap');
        const fieldsLine = /\|\s*fields ([^\n`]*)/.exec(body.slice(iHead > 0 ? iHead : 0));
        pin('host_total is no longer projected to the panel',
            !!fieldsLine && fieldsLine[1].indexOf('host_total') !== -1,
            'the field is computed and then dropped, so the panel falls back to the row count');
    }

    console.log('check-diagnostics: node-panel claims pinned (traffic scope, attribution key, ownership gate, host cap)');
}

// --- 3s: no timezone-dependent DAY key in any rollup (session 132) ----------
//
// `bin/bucket _time span=1d` and a `@d` snap resolve to midnight IN THE
// DISPATCHING USER'S TIMEZONE. The scheduled aggregates run in the server's
// timezone (UTC on the reference box); Settings -> Dashboard Data dispatches
// every backfill as the SIGNED-IN USER (America/Chicago on the reference box).
// For the day-keyed beaconing rollups that stored the same calendar day under
// two keys, and the dashboards SUM rows: measured, the Beaconing Domains KPI
// read 1,777 for 30 days against 688 / 1,089 per key family, with 73 days
// carrying both. The day is now UTC epoch arithmetic, floor(_time/86400)*86400,
// and every beaconing stanza narrows its dispatch window to the COMPLETE UTC
// days inside it (subsearch: addinfo -> ceil/floor to 86400), so a non-UTC
// search head cannot feed a partial UTC day. The same text sits in aggregate
// and backfill - section 3l's identity premise holds. Hourly `span=1h` keys are left alone:
// sub-day bins align to the EPOCH hour in every timezone. Measured in session
// 134 with the admin set to Asia/Kolkata (+05:30): daily bins moved to local
// midnight; hourly bins (bin, bucket, timechart) and an @h snap did not.
//
// Session 134 also bans strftime() from every rollup search. The compliance
// rollup classified after-hours with strftime(_time, "%H"/"%A") - the
// dispatcher's timezone - and put the flag in _key: 2,068 hour-groups were
// stored twice and Total Changes read +23.8% over 30 days. After-hours is now
// derived at read time (ChangeConfig AFTER_HOURS).
{
    const DEFAULT_DIR_3S = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const conf3s = fs.readFileSync(path.join(DEFAULT_DIR_3S, 'savedsearches.conf'), 'utf8');
    const stanzas3s = {};
    let cur3s = null;
    for (const raw of conf3s.split('\n')) {
        const m = /^\[(.+)\]\s*$/.exec(raw.trim());
        if (m) { cur3s = m[1]; stanzas3s[cur3s] = []; } else if (cur3s) stanzas3s[cur3s].push(raw);
    }
    const searchOf = (n) => {
        const line = (stanzas3s[n] || []).find((l) => /^search\s*=/.test(l));
        return line ? line.replace(/^search\s*=\s*/, '') : '';
    };
    const p3s = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3s ${label}: ${detail}`);
            failed = true;
        }
    };
    const rollupSearches = Object.keys(stanzas3s).filter((n) => /^logserv_.+_(aggregate|backfill)$/.test(n));
    p3s('denominator', rollupSearches.length >= 40,
        `only ${rollupSearches.length} rollup aggregate/backfill stanzas found - did the parse break?`);
    for (const n of rollupSearches) {
        const s = searchOf(n);
        p3s(`${n} bins by DAY`, !/span\s*=\s*1\s*d(ay)?\b/.test(s),
            'span=1d is a midnight in the dispatcher timezone - use floor(_time/86400)*86400');
        p3s(`${n} snaps to @d`, !/@d\b/.test(s),
            '@d is a midnight in the dispatcher timezone');
        p3s(`${n} formats time`, !/strftime\s*\(/.test(s),
            'strftime renders in the dispatcher timezone - a rollup key or value built from it differs between the schedule and a Settings backfill; derive it at read time or use epoch arithmetic');
    }
    const UTC_DAY = 'floor(_time/86400)*86400';
    const OVERRIDE = 'return earliest latest';
    const count = (s, needle) => s.split(needle).length - 1;
    const beacon = {
        logserv_beaconing_aggregate: { days: 1, overrides: 1 },
        logserv_beaconing_backfill: { days: 1, overrides: 1 },
        logserv_beaconing_detail_aggregate: { days: 2, overrides: 2 },
        logserv_beaconing_detail_backfill: { days: 2, overrides: 2 },
    };
    for (const [n, want] of Object.entries(beacon)) {
        const s = searchOf(n);
        p3s(`${n} present`, s.length > 0, 'stanza or search line missing');
        p3s(`${n} UTC day`, count(s, UTC_DAY) === want.days,
            `expected ${want.days} x ${UTC_DAY}, found ${count(s, UTC_DAY)}`);
        p3s(`${n} complete-UTC-day window`, count(s, OVERRIDE) === want.overrides,
            `every arm must narrow its window to the complete UTC days inside it (${want.overrides} expected, ${count(s, OVERRIDE)} found)`);
    }
}

// --- 3t: the backfill panel waits on the job; after-hours is read-time ------
//
// Session 134. The wait policy lives in utils/backfillPoll.ts (mutation-tested
// 28/28); these pins stop the panel from quietly growing its own ceiling back,
// and the compliance dashboard from reading a stored after-hours flag again.
{
    const HOME_3T = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const panel3t = fs.readFileSync(path.join(HOME_3T, 'components/RollupBackfillPanel.tsx'), 'utf8');
    const cc3t = fs.readFileSync(path.join(HOME_3T, 'dashboards/ChangeConfig.tsx'), 'utf8');
    const tr3t = fs.readFileSync(path.resolve(__dirname, '../src/main/resources/splunk/default/transforms.conf'), 'utf8');
    const p3t = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3t ${label}: ${detail}`);
            failed = true;
        }
    };
    p3t('panel poll ceiling', !/MAX_POLLS|MAX_NULL_STREAK|exceeded the poll ceiling/.test(panel3t),
        'a poll-count ceiling reports still-running searches as failed - use utils/backfillPoll.ts');
    p3t('panel wait policy', /from '\.\.\/utils\/backfillPoll'/.test(panel3t)
        && /decidePoll\(/.test(panel3t) && /pollDelayMs\(/.test(panel3t),
        'runArm must decide through decidePoll and pace through pollDelayMs');
    p3t('panel row outcomes', /mergeRowOutcome\(/.test(panel3t),
        'row outcomes must survive the post-run refresh (mergeRowOutcome)');
    p3t('after-hours read-time', /const AFTER_HOURS = /.test(cc3t)
        && !/\$\{MAIN\}\s*\|\s*search is_after_hours/.test(cc3t),
        'the compliance rollup no longer stores is_after_hours - derive it from bucket_ts (AFTER_HOURS)');
    const fl3t = /\[logserv_compliance_rollup\][\s\S]*?fields_list\s*=\s*([^\r\n]*)/.exec(tr3t);
    p3t('compliance fields_list', !!fl3t && !/is_after_hours/.test(fl3t[1]),
        'transforms.conf still lists is_after_hours for logserv_compliance_rollup');
    // Build 358: the Linux rollup and its raw twin must classify kernel lines the
    // same way, and the tag may not be a lone capital ("Write cache" -> W).
    // Build 374 (session 148): the raw twins' copy is KERNEL_REX in
    // utils/firewallChains.ts, the one copy Linux and Network Perimeter import.
    const ss3t = fs.readFileSync(path.resolve(__dirname, '../src/main/resources/splunk/default/savedsearches.conf'), 'utf8');
    const fwc3t = fs.readFileSync(path.join(HOME_3T, 'utils/firewallChains.ts'), 'utf8');
    // `rex field=_raw "` is 16 characters; the module's copy sits in a string
    // literal (every backslash doubled), so it is un-doubled before comparing.
    const kRe = /rex field=_raw "(kernel:[^"]*\(\?<kernel_event>[^"]*)"/g;
    const confRex = (ss3t.match(kRe) || []).map((m) => m.slice(16, -1));
    const modRex = (fwc3t.match(kRe) || []).map((m) => m.slice(16, -1).replace(/\\\\/g, '\\'));
    p3t('kernel rex count', confRex.length === 2 && modRex.length === 1,
        `expected 2 conf + 1 utils/firewallChains.ts kernel rex, found ${confRex.length} + ${modRex.length}`);
    p3t('kernel rex identity', new Set(confRex.concat(modRex)).size === 1,
        'the Linux aggregate, backfill and KERNEL_REX must carry the identical kernel rex');
    p3t('kernel rex tag shape', confRex.every((r) => r.includes('(?<kernel_event>[A-Z]{2}')),
        'the kernel_event tag must start with two capitals - a lone capital is a word fragment');
    // The copy compared above must be the value the dashboards import; evaluating
    // the module also proves the un-doubling read the literal right.
    const { KERNEL_REX } = loadTs(path.join(HOME_3T, 'utils/firewallChains'));
    p3t('kernel rex export', modRex.length === 1 && KERNEL_REX === `rex field=_raw "${modRex[0]}"`,
        'utils/firewallChains.ts must export its one kernel rex as KERNEL_REX');
    // The by-chain chart's series names come from the module: INPUT is the host,
    // FORWARD is transit. Swapped values would mislabel every chain.
    p3t('firewall series labels', /export const FW_SERIES_AT_HOST = 'At host \(INPUT\)';/.test(fwc3t)
        && /export const FW_SERIES_IN_TRANSIT = 'In transit \(FORWARD\)';/.test(fwc3t),
        'FW_SERIES_AT_HOST must name the INPUT chain and FW_SERIES_IN_TRANSIT the FORWARD chain');
    // Build 374: Linux and Network Perimeter show drops at the host (IN_DROP, INPUT
    // chain) beside drops in transit (FWD_DROP, FORWARD chain). The cached arm reads
    // the Linux rollup's exact `kernel` metric and the raw twin extracts with
    // KERNEL_REX; neither dashboard may carry a kernel rex of its own again.
    const linux3t = fs.readFileSync(path.join(HOME_3T, 'dashboards/Linux.tsx'), 'utf8');
    const np3t = fs.readFileSync(path.join(HOME_3T, 'dashboards/NetworkPerimeter.tsx'), 'utf8');
    [['Linux.tsx', linux3t], ['NetworkPerimeter.tsx', np3t]].forEach(([f, s]) => {
        p3t(`${f} imports KERNEL_REX`,
            /import\s*\{[^}]*\bKERNEL_REX\b[^}]*\}\s*from\s*'\.\.\/utils\/firewallChains';/.test(s),
            'the dashboard must import KERNEL_REX from ../utils/firewallChains');
        p3t(`${f} no own kernel rex`, !/\(\?<kernel_event>/.test(s),
            'the kernel_event extraction lives only in utils/firewallChains.ts (KERNEL_REX)');
    });
    // Each query pin names its key: a bare substring is also satisfied by a sibling
    // query (the KPI's text recurs in its sparkline), so a repointed KPI would pass.
    // Cached and raw share key names but start differently (${KERNEL} vs
    // ${RAW_LSEC}), so each prefix names one arm. A line counts when its text after
    // the indentation starts with the prefix; a '//' or ' * ' commented-out copy
    // does not (a bare line inside a block comment still would).
    const line3t = (s, prefix) => s.split('\n').some((l) => l.trimStart().startsWith(prefix));
    const CHAIN_3T = '| eval chain=if(kernel_event="FWD_DROP", "${FW_SERIES_IN_TRANSIT}", "${FW_SERIES_AT_HOST}") |';
    const FWD_3T = 'the in-transit count must read KERNEL filtered to kernel_event="FWD_DROP"';
    const RAW_3T = 'the in-transit raw twin must extract with KERNEL_REX and keep kernel_event="FWD_DROP"';
    const CHART_3T = 'the by-chain chart must keep both chains and label FWD_DROP in transit';
    [
        [linux3t, 'Linux.tsx kpiFwdDrops cached', FWD_3T,
            'kpiFwdDrops: `${KERNEL} | search kernel_event="FWD_DROP" |'],
        [linux3t, 'Linux.tsx kpiFwdDrops raw', RAW_3T,
            'kpiFwdDrops: `${RAW_LSEC} | ${KERNEL_REX} | where kernel_event="FWD_DROP" |'],
        [linux3t, 'Linux.tsx sparkFwdDrops cached', FWD_3T,
            'sparkFwdDrops: `${KERNEL} | search kernel_event="FWD_DROP" |'],
        [linux3t, 'Linux.tsx fwTimeline cached', `${CHART_3T}, read from KERNEL`,
            'fwTimeline: `${KERNEL} | search kernel_event="IN_DROP" OR kernel_event="FWD_DROP" ' + CHAIN_3T
                + ' eval _time=bucket_ts | timechart span=__LSV_SPAN__ sum(count) by chain |'],
        [linux3t, 'Linux.tsx fwTimeline raw', `${CHART_3T}, extracted with KERNEL_REX`,
            'fwTimeline: `${RAW_LSEC} | ${KERNEL_REX} | where kernel_event="IN_DROP" OR kernel_event="FWD_DROP" ' + CHAIN_3T
                + ' timechart span=__LSV_SPAN__ count by chain |'],
        [np3t, 'NetworkPerimeter.tsx kpiFwd cached', FWD_3T,
            'kpiFwd: `${KERNEL} | search kernel_event="FWD_DROP" |'],
        [np3t, 'NetworkPerimeter.tsx kpiFwd raw', RAW_3T,
            'kpiFwd: `${RAW_LSEC} | ${KERNEL_REX} | where kernel_event="FWD_DROP" |'],
        [np3t, 'NetworkPerimeter.tsx sparkFwd cached', FWD_3T,
            'sparkFwd: `${KERNEL} | search kernel_event="FWD_DROP" |'],
        // Which collection KERNEL reads. Network Perimeter's own rollup has no
        // kernel metric: pointed at its ${ROLL}, the in-transit KPI and sparkline
        // would read 0 with no error (the count KPIs are empty-safe).
        [linux3t, 'Linux.tsx ROLL', 'Linux must read logserv_linux_rollup',
            "const ROLL = 'logserv_linux_rollup';"],
        [linux3t, 'Linux.tsx KERNEL source', 'KERNEL must read the kernel metric of ROLL',
            'const KERNEL = `| inputlookup ${ROLL} where metric="kernel" ${RANGE}`;'],
        [np3t, 'NetworkPerimeter.tsx KERNEL source',
            'KERNEL must read logserv_linux_rollup metric="kernel" (the perimeter rollup has none)',
            'const KERNEL = `| inputlookup logserv_linux_rollup where metric="kernel" ${RANGE}`;'],
    ].forEach(([s, label, why, prefix]) => {
        p3t(label, line3t(s, prefix), `${why}; expected a line starting ${prefix}`);
    });
    console.log('check-diagnostics: 3t backfill wait policy + read-time after-hours + kernel firewall chains pinned');
}

// --- 3u: the Dashboard Data history checks are limited, retried, labelled ---
//
// Session 144 (build 370). The policy lives in utils/historyCheck.ts (its suite
// is mutation-tested 29/29); these pins stop the panel from going back to firing
// every row's check at once, or to showing a check that measured nothing as the
// muted dash or as "empty".
{
    const panel3u = fs.readFileSync(path.resolve(__dirname,
        '../src/main/webapp/pages/home/components/RollupBackfillPanel.tsx'), 'utf8');
    const p3u = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3u ${label}: ${detail}`);
            failed = true;
        }
    };
    p3u('policy module', /from '\.\.\/utils\/historyCheck'/.test(panel3u)
        && /classifyCheckResponse\(res\.status, body\)/.test(panel3u),
        'the history check must classify its response through utils/historyCheck.ts');
    // Session 147 (build 372): lateCheckOnce is the second oneshot; 3w pins how it runs.
    // Build 378 (design_impact.md F1, its review): stageCountOnce is the third -
    // it counts one staged part before and after the part's combine search; 3bs (f)
    // pins how it runs. Each oneshot fetch is attributed to the top-level function
    // that holds it, so a fourth caller - or one of these three moved elsewhere -
    // fails here.
    const oneshots3u = [];
    {
        const re3u = /fetch\(`\$\{NS_PREFIX\}\/search\/jobs\/oneshot/g;
        let m3u;
        while ((m3u = re3u.exec(panel3u)) !== null) {
            const line3u = panel3u.slice(panel3u.lastIndexOf('\n', m3u.index) + 1, m3u.index).trim();
            if (/^(\/\/|\/?\*)/.test(line3u)) continue; // a comment names the endpoint; it does not call it
            const head3u = panel3u.lastIndexOf('\nconst ', m3u.index);
            const name3u = head3u === -1 ? null
                : /^\nconst ([A-Za-z0-9_]+) = async\b/.exec(panel3u.slice(head3u, head3u + 80));
            oneshots3u.push(name3u ? name3u[1] : '?');
        }
    }
    p3u('three oneshots', JSON.stringify(oneshots3u.slice().sort())
        === JSON.stringify(['checkOnce', 'lateCheckOnce', 'stageCountOnce']),
        'the panel may call search/jobs/oneshot from checkOnce, lateCheckOnce and stageCountOnce only, once each'
        + ` - found ${JSON.stringify(oneshots3u)}`);
    const calls3u = (panel3u.match(/checkOnce\(/g) || []).length;
    const limited3u = (panel3u.match(/limit\(\(\) => runCheck\(\(\) => checkOnce\(/g) || []).length;
    p3u('limited + retried', calls3u >= 1 && calls3u === limited3u,
        `every checkOnce call must run as limit(() => runCheck(() => checkOnce(...))) - ${limited3u} of ${calls3u} do`);
    p3u('per-panel limiter', /createLimiter\(CHECK_CONCURRENCY\)/.test(panel3u),
        'the panel must build its limiter from CHECK_CONCURRENCY');
    p3u('no unknown history', !/status: 'unknown', oldestMs/.test(panel3u),
        'a history check that measured nothing is checkfailed, never unknown');
    p3u('failed check labelled', /'check failed —'/.test(panel3u) && /status === 'checkfailed'/.test(panel3u),
        'the History cell must label a failed check as one');
    console.log('check-diagnostics: 3u history checks limited, retried and labelled');
}

// --- 3v: every time chart fills its panel ------------------------------------
//
// Session 144 (build 371). A grid row is as tall as its tallest panel - usually
// a table - and a chart beside one kept its fixed 280 px with an empty band
// below it. The chart now asks its FramedPanel for fill mode and draws at the
// measured height, out of flow so it never holds the row open. These pins stop
// either half from quietly going back to the fixed height.
{
    const comp3v = path.resolve(__dirname, '../src/main/webapp/pages/home/components');
    const ts3v = fs.readFileSync(path.join(comp3v, 'TimeSeriesChart.tsx'), 'utf8');
    const fp3v = fs.readFileSync(path.join(comp3v, 'FramedPanel.tsx'), 'utf8');
    const p3v = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3v ${label}: ${detail}`);
            failed = true;
        }
    };
    p3v('chart asks for fill', /useRequestPanelFill\(\);/.test(ts3v),
        'TimeSeriesChart must call useRequestPanelFill() so its panel becomes a flex column');
    p3v('drawn at the measured height', /<Viz [^>]*height=\{drawHeight\}/.test(ts3v)
        && !/<Viz [^>]*height=\{height\}/.test(ts3v) && /new ResizeObserver\(/.test(ts3v),
        'the chart must be drawn at the observed container height, not the fixed prop height');
    p3v('out of flow', /<Fill>\s*<LegendTitleTooltips>/.test(ts3v)
        && /const Fill = styled\.div`\s*position: absolute;/.test(ts3v),
        'the drawn chart must sit in the absolutely positioned Fill, or it holds the grid row open');
    p3v('floor + grow', /min-height: \$\{\(p\) => p\.\$minHeight\}px;\s*flex: 1 1 auto;/.test(ts3v),
        'the chart container must keep the prop height as a floor and grow as a flex item');
    p3v('panel honours it', /<PanelFillContext\.Provider value=\{requestFill\}>/.test(fp3v)
        && /<Body \$fill=\{fillHeight \|\| chartFill\}>/.test(fp3v),
        'FramedPanel must provide PanelFillContext and turn its Body into a flex column on request');
    console.log('check-diagnostics: 3v time charts fill their panels');
}

// --- shared: a conf key read the way Splunk reads it (build 376, round 4) ---
//
// The LAST occurrence of `key` in a stanza body, with any spacing around the
// `=` and any leading indentation: Splunk reads `key=value` as well as
// `key = value`, and the last of a repeated key wins, so a reader that knows
// one spelling only is bypassed by a later line spelled another way. 3w, 3x,
// 3y and 3z read their keys through it, and 3y also pins one spelling for
// every key line of savedsearches.conf, so such a line fails on its own.
const confLast = (body, key) => {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^[ \\t]*' + k + '[ \\t]*=[ \\t]*(.*?)[ \\t]*$', 'gm');
    let v = null;
    for (let m = re.exec(body || ''); m; m = re.exec(body || '')) v = m[1];
    return v;
};

// --- 3w: the two-hour aggregate re-scan + the late-arriving data check -----
//
// Session 147 (build 372). The bucket-local hourly aggregates re-scan the last
// two complete hours (-2h@h..@h): an event that arrives minutes after its hour
// was read, or an hour whose run was skipped, is rebuilt by the next run. Not
// wider: a `| union` arm is a subsearch Splunk auto-finalizes at ~30 s, and a
// truncated arm writes LOWER counts over good rows (an 8-day re-scan hit it on
// the reference box). Later arrivals are found by [logserv_late_arrival_check]
// and rebuilt by Settings -> Dashboard Data, one top-level search per arm. The
// check's pure logic is lateArrivals.consistency-test; these pins hold the conf
// and the panel to it. Round 4 (build 376): keys are read with confLast - the
// last value, any spacing (this read the first, in one spelling only).
{
    const SS_3W = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'savedsearches.conf');
    const ss3w = fs.readFileSync(SS_3W, 'utf8').replace(/\r\n/g, '\n');
    const panel3w = fs.readFileSync(path.resolve(__dirname,
        '../src/main/webapp/pages/home/components/RollupBackfillPanel.tsx'), 'utf8');
    const p3w = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3w ${label}: ${detail}`);
            failed = true;
        }
    };
    const bodies3w = {};
    ss3w.split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\]\n/.exec(chunk);
        if (m) bodies3w[m[1]] = chunk.slice(m[0].length);
    });
    const field3w = confLast;
    // Kept at -1h@h on purpose: the inventory is keyed by value, not by hour, and
    // the platform snapshot reads _internal with whole-window top-N rows.
    const KEEP_1H = ['logserv_topology_aggregate_inventory', 'logserv_diag_platform_aggregate'];
    const hourly3w = Object.keys(bodies3w).filter((n) => /^logserv_\w*aggregate\w*$/.test(n)
        && /^\d+ \* \* \* \*$/.test(field3w(bodies3w[n], 'cron_schedule') || ''));
    p3w('hourly aggregates', hourly3w.length === 27, `expected 27 hourly aggregates, found ${hourly3w.length}`);
    hourly3w.forEach((n) => {
        const want = KEEP_1H.indexOf(n) !== -1 ? '-1h@h' : '-2h@h';
        const e = field3w(bodies3w[n], 'dispatch.earliest_time');
        const l = field3w(bodies3w[n], 'dispatch.latest_time');
        p3w(`${n} window`, e === want && l === '@h', `expected ${want}..@h, found ${e}..${l}`);
    });
    const lc = bodies3w.logserv_late_arrival_check;
    const lcs = field3w(lc, 'search') || '';
    p3w('check stanza', !!lc && lcs.length > 0, '[logserv_late_arrival_check] is missing or has no search');
    // Build 373 (user, 2026-10-01): daily by default, recorded as a triggered alert
    // when more than the summary row comes back. The census above keeps the slot
    // collision-free; 05:40 is also clear of the retention band that rewrites the
    // reference rollup (a read mid-rewrite would invent late days).
    p3w('check daily', field3w(lc, 'enableSched') === '1' && field3w(lc, 'cron_schedule') === '40 5 * * *'
        && field3w(lc, 'dispatch.earliest_time') === '-30d@d' && field3w(lc, 'dispatch.latest_time') === '-3h@h',
        'the check runs daily at 05:40 over -30d@d..-3h@h');
    p3w('check alerts', field3w(lc, 'alert.track') === '1' && field3w(lc, 'counttype') === 'number of events'
        && field3w(lc, 'relation') === 'greater than' && field3w(lc, 'quantity') === '1',
        'a triggered alert when more than the summary row comes back');
    p3w('check read-only', !/\|\s*(outputlookup|collect|tscollect|delete|sendalert|sendemail)\b/.test(lcs),
        'the check must not write anything');
    p3w('check compares', /^\| tstats count as raw where `sap_logserv_idx_macro` by _time span=1h sourcetype \|/.test(lcs)
        && /\| inputlookup append=true logserv_mc_rollup where metric="count" \| addinfo \|/.test(lcs)
        && /\| stats sum\(raw\) as raw sum\(kv\) as kv by bucket_ts sourcetype \|/.test(lcs)
        && /\| where raw>kv \|/.test(lcs),
        'tstats vs the Multi-Cloud count rollup, per hour and sourcetype, reporting only raw > kv');
    p3w('check no subsearch', !/\|\s*(append|join|union)\s*\[/.test(lcs),
        'a subsearch row or time limit would truncate the reference and invent late days');
    p3w('check oldest bound', /\| eventstats min\(kvb\) as mc_oldest \|/.test(lcs)
        && /bucket_ts>=info_min_time AND bucket_ts<info_max_time AND bucket_ts>=mc_oldest/.test(lcs),
        'hours older than the rollup\'s oldest bucket must never be judged (a new install would alert on all of them)');
    p3w('check day key', /day_ts=floor\(bucket_ts\/86400\)\*86400/.test(lcs) && !/strftime\(/.test(lcs),
        'the day key is epoch arithmetic (gate 3s), never strftime');
    p3w('check summary row',
        /\| appendpipe \[stats count as late_days sum\(missing\) as late_events \| eval day_ts="all"\]$/.test(lcs),
        'the search must end with its summary row, so an empty answer cannot pass for a clean one');
    p3w('panel reads the stanza', /fetchBackfillSpl\(LATE_CHECK_STANZA\)/.test(panel3w)
        && /from '\.\.\/utils\/lateArrivals'/.test(panel3w),
        'the panel must dispatch the conf search, through utils/lateArrivals.ts');
    p3w('panel limited + retried', /checkLimit\(\(\) => runCheck\(\s*\(\) => lateCheckOnce\(/.test(panel3w)
        && (panel3w.match(/lateCheckOnce\(/g) || []).length === 1,
        'lateCheckOnce must run once, as checkLimit(() => runCheck(() => lateCheckOnce(...)))');
    p3w('panel requires the summary row', /x\.day_ts === 'all'/.test(panel3w),
        'a check answer without its summary row must fail, not read as clean');
    p3w('panel re-checks', /void runLateCheck\(colls\[LATE_CHECK_ROLLUP_KEY\], aggs\[LATE_CHECK_ROLLUP_KEY\]\);/.test(panel3w),
        'every refresh - including the one after a backfill - must re-run the check');
    p3w('panel rebuilds the days', /buildWorkItems\(defs, wins, fixed30\)/.test(panel3w)
        && /runBackfill\(ROLLUPS, lateWins\.windows, fixed30Result\.window\)/.test(panel3w),
        'the one-click rebuild must dispatch one window per run of late days through the per-arm backfill');
    console.log(`check-diagnostics: 3w ${hourly3w.length} hourly windows + the late-arriving data check pinned`);
}

// --- 3bs: the backfill stages the tails that combine rows across arms (build 378) -
//
// Build 378 (design_impact.md F1). Settings -> Dashboard Data dispatches each
// union arm of a *_backfill stanza as its own top-level search, because a union
// arm is a subsearch Splunk auto-finalizes and a cut arm writes LOWER counts.
// Two tails combine rows ACROSS the arms - the Environment Topology nodes
// (`stats sum(event_count) ... by canonical_kind, canonical_value, _time`) and
// the inventory (build 378: `stats values(resolved_sid) ... | where mvcount(...)=1`;
// from build 379 `stats sum(n), max(last_seen) ... by ..., resolved_sid` and
// the most-recent-SID choice) - and per arm the last arm overwrote the sum and
// a cross-arm SID conflict was written. utils/backfillPlan.ts stages those arms into the scratch KV
// collection logserv_backfill_stage, one part (window chunk) at a time, and
// combines each part in one top-level search that runs the stanza's own tail;
// backfillPlan.consistency-test proves the rows equal a single-pipeline union
// (mutation-tested) and that every other stanza is planned exactly as before.
// These pins hold the panel and the conf to that design:
//  (a) the panel plans through utils/backfillPlan.ts and keeps no union
//      splitter of its own (a second copy drifts - the session-062 lesson);
//  (b) a part's combine search waits for every arm of the part and runs only
//      when all of them are done; a staged arm left running counts as failed
//      (it is never combined); a part's staged rows are deleted only once no
//      combine search may still read them;
//  (c) the panel deletes from the stage only with a query (one part, or the
//      orphan age) and never clears it whole;
//  (d) the stage's conf pair: the transforms lookup is a kvstore lookup whose
//      fields_list is STAGE_FIELDS_LIST in order, with no time_field (the
//      combine must read the whole part whatever its dispatch window); the
//      collection declares exactly those fields, lsv_staged_at a number (the
//      orphan sweep's $lt bound is a JSON number) and the rest strings, and an
//      index on lsv_part (the combine's where and the part delete);
//  (e) the upgrade note names its rows from the registry;
//  (f) every staged row is accounted for (the build-378 review): a staged arm counts
//      as done only through stagedArmResult (its job's result count, no ERROR
//      message - read by pollJobOnce through readJobFacts), adding its rows to
//      the part's expected count before it resolves the part; the combine
//      search runs only after reconcilePart has found exactly that many rows
//      in the stage, is dispatched through guardedMergeSpl (`require` fails an
//      empty read), is judged by mergeJobVerdict, and is followed by a second
//      reconcilePart; the part's row verdict is mergeRowVerdict; the count is
//      the oneshot stageCountOnce (stageCountSpl, classifyPartCount, retried by
//      decidePartCount) - utils/backfillPlan.ts holds the logic and its suite
//      (section H) proves a short, an empty and an over-read all fail;
//  (g) the orphan sweep measures age on the SERVER's clock (serverNowSec reads
//      the Date header through serverClockSec), never the browser's.
{
    const H3BS = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const D3BS = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const p3bs = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3bs ${label}: ${detail}`);
            failed = true;
        }
    };
    const panel3bs = fs.readFileSync(path.join(H3BS, 'components/RollupBackfillPanel.tsx'), 'utf8');
    const plan3bs = loadTs(path.join(H3BS, 'utils/backfillPlan'));
    const STAGE3BS = plan3bs.STAGE_COLLECTION;
    const FIELDS3BS = Array.isArray(plan3bs.STAGE_FIELDS_LIST) ? plan3bs.STAGE_FIELDS_LIST : [];
    p3bs('stage constants', STAGE3BS === 'logserv_backfill_stage' && FIELDS3BS[0] === '_key' && FIELDS3BS.length >= 4,
        `utils/backfillPlan.ts exports STAGE_COLLECTION ${STAGE3BS} and STAGE_FIELDS_LIST [${FIELDS3BS.join(', ')}]`);

    // (a)
    p3bs('panel plans through utils/backfillPlan.ts', /from '\.\.\/utils\/backfillPlan'/.test(panel3bs)
        && /planRollupItems\(loaded, wins, fixed30, \(s\) => FIXED30_BACKFILL_STANZAS\.has\(s\), nextPart\)/.test(panel3bs),
        'buildWorkItems must expand each rollup with planRollupItems, pinning FIXED30_BACKFILL_STANZAS');
    p3bs('panel keeps no union splitter of its own', !/\bconst parseUnion\b/.test(panel3bs)
        && !/\bparseUnion\(/.test(panel3bs) && !/\\\|\\s\*union\\b/.test(panel3bs),
        'the splitter lives in utils/backfillPlan.ts only, held to the pre-378 copy by its test');

    // (b)
    p3bs('merge waits for its part', /await part\.done;/.test(panel3bs)
        && /if \(mergeAllowed\(part\.verdicts, part\.total\)\) \{/.test(panel3bs)
        && /part\.verdicts\.push\(staged\.verdict\);\s*if \(part\.verdicts\.length >= part\.total\) part\.resolve\(\);/
            .test(panel3bs),
        'a combine search may run only once every arm of its part has reported, and all of them done');
    p3bs('staged arm left running is a failure', /verdict = stagedArmRowVerdict\(staged\.verdict\);/.test(panel3bs),
        'a staged arm the panel stopped waiting for is never combined - not "still running on server"');
    p3bs('staged rows kept under a running merge',
        /if \(stageDeletable\(outcome\)\) await deleteStageRows\(partQuery\(it\.part\)\);\s*else part\.keepStage = true;/
            .test(panel3bs)
        && /\.filter\(\(\[, p\]\) => !p\.settled && !p\.keepStage\)/.test(panel3bs),
        'a part\'s staged rows go only when no combine search may still be reading them, and it reconciled');

    // (c)
    const urls3bs = panel3bs.split('${STAGE_COLLECTION}').length - 1;
    const at3bs = panel3bs.indexOf('/storage/collections/data/${STAGE_COLLECTION}');
    const near3bs = at3bs === -1 ? '' : panel3bs.slice(at3bs, at3bs + 160);
    p3bs('stage deletes carry a query', urls3bs === 1
        && /\?output_mode=json`\s*\+ `&query=\$\{encodeURIComponent\(JSON\.stringify\(query\)\)\}`/.test(near3bs),
        'the one stage URL (in deleteStageRows) must always carry &query=<the JSON query> - a DELETE without one empties'
        + ' the stage under every part still being combined');
    const calls3bs = (panel3bs.match(/deleteStageRows\(/g) || []).length;
    const scoped3bs = (panel3bs.match(/deleteStageRows\((partQuery|orphanQuery)\(/g) || []).length;
    p3bs('stage deletes are part- or age-scoped', calls3bs >= 3 && calls3bs === scoped3bs,
        `${scoped3bs} of ${calls3bs} deleteStageRows calls pass partQuery(...) or orphanQuery(...)`);
    p3bs('Clear never names the stage', !/clearCollection\(\s*STAGE_COLLECTION/.test(panel3bs),
        'the stage is scratch space, emptied part by part');

    // (d)
    const blocks3bs = (file) => {
        const out = {};
        fs.readFileSync(path.join(D3BS, file), 'utf8').replace(/\r\n/g, '\n').split(/^(?=\[)/m).forEach((chunk) => {
            const h = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
            if (h) out[h[1]] = (out[h[1]] || '') + chunk.slice(h[0].length);
        });
        return out;
    };
    const live3bs = (body) => (body || '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const tf3bs = live3bs(blocks3bs('transforms.conf')[STAGE3BS]);
    const co3bs = live3bs(blocks3bs('collections.conf')[STAGE3BS]);
    p3bs('transforms lookup', confLast(tf3bs, 'external_type') === 'kvstore'
        && confLast(tf3bs, 'collection') === STAGE3BS
        && confLast(tf3bs, 'fields_list') === FIELDS3BS.join(', ')
        && confLast(tf3bs, 'time_field') === null,
        `transforms.conf [${STAGE3BS}] must be a kvstore lookup on ${STAGE3BS}, fields_list exactly`
        + ` "${FIELDS3BS.join(', ')}" (outputlookup writes only fields_list fields) and no time_field`);
    const declared3bs = {};
    co3bs.split('\n').forEach((l) => {
        const m = /^\s*field\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)\s*$/.exec(l);
        if (m) declared3bs[m[1]] = m[2];
    });
    const want3bs = {};
    FIELDS3BS.filter((f) => f !== '_key').forEach((f) => {
        want3bs[f] = f === plan3bs.STAGE_TIME_FIELD ? 'number' : 'string';
    });
    p3bs('collection fields', JSON.stringify(Object.keys(declared3bs).sort().map((k) => [k, declared3bs[k]]))
        === JSON.stringify(Object.keys(want3bs).sort().map((k) => [k, want3bs[k]])),
        `collections.conf [${STAGE3BS}] must declare exactly ${JSON.stringify(want3bs)} - found ${JSON.stringify(declared3bs)}`);
    p3bs('collection index on the part', /^\s*accelerated_fields\.[A-Za-z0-9_]+\s*=\s*\{\s*"lsv_part"\s*:\s*1\s*\}\s*$/m
        .test(co3bs), `collections.conf [${STAGE3BS}] must index lsv_part`);

    // (f)
    p3bs('staged arm proves its rows', /facts: readJobFacts\(res\.status, body\)/.test(panel3bs)
        && /const staged = stagedArmResult\(ran\.verdict, ran\.facts\);/.test(panel3bs)
        && /part\.expected \+= staged\.rows;\s*part\.verdicts\.push\(staged\.verdict\);/.test(panel3bs),
        'a staged arm is done only with its job\'s result count and no ERROR message, its rows added before it reports');
    const mergeAt3bs = panel3bs.indexOf('if (mergeAllowed(part.verdicts, part.total)) {');
    const mergeEnd3bs = mergeAt3bs === -1 ? -1 : panel3bs.indexOf('part.settled = true;', mergeAt3bs);
    const mergeBody3bs = mergeEnd3bs === -1 ? '' : panel3bs.slice(mergeAt3bs, mergeEnd3bs);
    const before3bs = mergeBody3bs.indexOf('const before = await reconcilePart(it.part, part.expected, ');
    const run3bs = mergeBody3bs.search(/runArm\(\s*guardedMergeSpl\(it\.spl, it\.part, part\.expected\)/);
    const after3bs = mergeBody3bs.indexOf('const after = await reconcilePart(it.part, part.expected, ');
    p3bs('combine reconciled', before3bs !== -1 && run3bs > before3bs && after3bs > run3bs
        && /if \(before\.kind === 'mismatch'\) \{\s*outcome = 'unreconciled';/.test(mergeBody3bs)
        && /outcome = mergeJobVerdict\(ran\.verdict, ran\.facts\);/.test(mergeBody3bs)
        && /if \(after\.kind === 'mismatch'\) \{\s*outcome = 'unreconciled';/.test(mergeBody3bs)
        && /verdict = mergeRowVerdict\(outcome\);/.test(panel3bs)
        && (panel3bs.match(/await runArm\(/g) || []).length === 2,
        'the combine runs only after the stage holds exactly the rows its arms wrote, as guardedMergeSpl, judged by'
        + ' mergeJobVerdict, and is counted again after - one guarded runArm in the merge, one for every other item');
    const countAt3bs = panel3bs.indexOf('const stageCountOnce = async');
    const countEnd3bs = countAt3bs === -1 ? -1 : panel3bs.indexOf('\n};\n', countAt3bs);
    const countBody3bs = countEnd3bs === -1 ? '' : panel3bs.slice(countAt3bs, countEnd3bs);
    p3bs('part count', /params\.set\('search', stageCountSpl\(part\)\);/.test(countBody3bs)
        && /fetch\(`\$\{NS_PREFIX\}\/search\/jobs\/oneshot/.test(countBody3bs)
        && /return classifyPartCount\(res\.status, body\);/.test(countBody3bs)
        && /const d = decidePartCount\(a, expected, attempts\);/.test(panel3bs),
        'the part count is the oneshot of stageCountSpl, classified by classifyPartCount and retried by decidePartCount');

    // (g)
    p3bs('orphan sweep on the server clock', /deleteStageRows\(orphanQuery\(serverSec\)\)/.test(panel3bs)
        && /serverClockSec\(res\.headers\.get\('Date'\)\)/.test(panel3bs)
        && !/orphanQuery\(\s*Date\.now/.test(panel3bs),
        'lsv_staged_at is the server\'s now(): the sweep\'s cutoff must come from the server\'s clock, never Date.now()');

    // (e)
    p3bs('upgrade note rows from the registry', /\{upgradeRows\(UPGRADE_NOTE_CLEAR_THEN_BACKFILL\)\}/.test(panel3bs)
        && /\{upgradeRows\(UPGRADE_NOTE_BACKFILL_ONLY\)\}/.test(panel3bs)
        && /\{upgradeRows\(UPGRADE_NOTE_TRACE_NAMES\)\}/.test(panel3bs),
        'the notes list routes/rollupRegistry.ts UPGRADE_NOTE_* rows by their table labels (build 381: the trace-name note too)');
    console.log(`check-diagnostics: 3bs the backfill stages cross-arm tails in ${STAGE3BS}`
        + ` (${FIELDS3BS.length} fields), combines a part only when all its arms are done and every staged row`
        + ` reads back, and deletes staged rows by part (${scoped3bs} scoped deletes) on the server's clock`);
}

// --- 3x: every retention overwrite refuses an empty read --------------------
//
// Session 148 (build 375). A retention trims its collection by rewriting it
// whole: `| inputlookup X | where <bucket> >= -365d | outputlookup X`. Without
// override_if_empty=false an outputlookup DELETES the collection when its input
// is empty, and a KV inputlookup can come back empty while mongod warms up
// after a Splunkd restart: one restart during the nightly retention band would
// erase a rollup's history, which a backfill can rebuild only while the raw
// events are still indexed. The session-096 rule, until now kept for the Data
// Doctor and IP-enrichment collections only, covers every retention. These pins
// read the `search = ` line only, so a # comment that quotes the token can
// never satisfy one:
//  (a) the conf's retentions are the registry's retentionSearches plus the two
//      Data Doctor retentions - a new rollup cannot ship one this section skips;
//  (b) every `| outputlookup` on those lines carries override_if_empty=false
//      and no append= - 30 clauses in 30 stanzas;
//  (c) each retention writes back the collections it read, in the same order;
//  (d) session 149 (build 376): each retention reads and writes ONE
//      collection, at the top level - exactly one inputlookup and one
//      outputlookup, and no `[` outside a quoted string. Until build 375 the
//      topology retention wrote the nodes and then, inside `append [...]`, the
//      edges: a subsearch's time limit (60 s for an explicit append) can cut
//      what it reads, and the flag cannot tell a partial read from a full one.
//      The edges have their own [logserv_topology_edges_retention] at 02:36
//      (the session-095 rule: one search per collection).
//  (e) session 149 (build 376, round 2): every retention is enabled and
//      scheduled once a day inside the nightly band, 00:30-02:36 server local
//      time (BAND_3X) - the band the deploy guard, the late-arrival check and
//      the docs assume - and the edges retention sits at exactly 36 2 * * *
//      (re-run the cron census before moving it). A key repeated in a stanza
//      is read as Splunk reads it: the last value.
//  (f) session 149 (build 376, round 3): override_if_empty=false is the only
//      option an outputlookup on a retention may carry (max=N keeps N rows
//      of the collection it rewrites, every night). And a coverage pin that
//      does not trust retentionSearches: every time-bucketed collection -
//      the registry's completenessCollections, the IP enrichment and the
//      two Data Doctor collections - is read and written at the top level by
//      exactly ONE [logserv_*_retention], and every other collection the
//      registry lists is exempted by name (FLAT_3X), so dropping a retention
//      from the registry and the conf together still fails here.
//  (g) session 149 (build 376, round 4): each retention reads its whole
//      collection and keeps exactly what its window keeps. Every retention
//      reads with a bare `| inputlookup <collection>` (no option, no where
//      clause), has one `| where` and no head / tail / top / rare / sample
//      / dedup / uniq at command position ('reads whole'); and every
//      retention but the three in SHAPE_EXEMPT_3X is exactly
//      `| inputlookup C | where bucket_ts >= relative_time(now(), "-365d")
//      | outputlookup override_if_empty=false C | stats count` (day_ts for
//      the daily rollups; the window comes from RET_DAYS_3X) - 'search
//      shape'. The three keep another window, pinned where it is derived:
//      the IP enrichment in 3r, the Data Doctor pair in 3b and 3f. The (f)
//      coverage pin is now '<collection> one retention': it proves that
//      exactly one retention reads and writes the collection; the shape
//      proves the trim. Keys are read with confLast (the last value, any
//      spacing).
//  (h) session 149 (build 376, round 5): the window trims the field the
//      collection has - SHAPE_3X captures it, and collections.conf must
//      declare exactly one of field.bucket_ts / field.day_ts = number for C,
//      that one (a where on a field the rows lack keeps every row, so the
//      collection would never be trimmed). The three exempt retentions are
//      pinned line for line as well (SHAPE_EXEMPT_LINES_3X, the same
//      '<n> search shape' label): a `| search`, `| regex` or `| stats` stage
//      passes 'reads whole' and the token pins of 3b, 3f and 3r, but not the
//      exact line. The Data Doctor reports' row cap is diagPersistence.ts's
//      RETENTION_MAX_ROWS, as in 3b.
// No clause-count literal: (a) makes the stanzas the registered set and (d)
// gives each one outputlookup, so the count follows from them.
// The flag guards an EMPTY read only: a partial read still overwrites, and a
// collection whose rows have all expired keeps them (Clear still empties it).
// Section 3y holds the same flag on the only other overwrites, the ES feeds.
{
    const SS_3X = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'savedsearches.conf');
    const ss3x = fs.readFileSync(SS_3X, 'utf8').replace(/\r\n/g, '\n');
    const p3x = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3x ${label}: ${detail}`);
            failed = true;
        }
    };
    const names3x = [];
    const bodies3x = {};
    ss3x.split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (m) {
            names3x.push(m[1]);
            bodies3x[m[1]] = chunk.slice(m[0].length);
        }
    });

    // (a) the retention set. The Data Doctor's report and platform-snapshot
    // collections are not dashboard rollups, so the registry does not list them.
    const registry3x = loadTs(path.resolve(__dirname, '../src/main/webapp/pages/home/routes/rollupRegistry'));
    const DIAG_3X = ['logserv_diag_reports_retention', 'logserv_diag_platform_retention'];
    const want3x = [].concat(...(registry3x.ROLLUPS || []).map((d) => d.retentionSearches || [])).concat(DIAG_3X);
    const ret3x = names3x.filter((n) => /^logserv_\w+_retention$/.test(n));
    const missing3x = want3x.filter((n) => ret3x.indexOf(n) === -1);
    const extra3x = ret3x.filter((n) => want3x.indexOf(n) === -1);
    p3x('retention set', missing3x.length === 0 && extra3x.length === 0,
        `the conf's [logserv_*_retention] stanzas must be the registry's retentionSearches + ${DIAG_3X.join(' + ')}`
        + ` - missing [${missing3x.join(', ')}], not registered [${extra3x.join(', ')}]`);
    p3x('one of each', new Set(ret3x).size === ret3x.length && new Set(want3x).size === want3x.length,
        'a retention stanza is defined twice in the conf, or listed twice in the registry');

    // (b) + (c), per search line. An option is a key=value token; the bare
    // token is the collection (an inputlookup's `where` clause follows it).
    const OUT_3X = /\|\s*outputlookup\b[^|\]]*/gi;
    const IN_3X = /\|\s*inputlookup\b[^|\]]*/gi;
    const clause3x = (c) => {
        const toks = c.replace(/^\|\s*\w+/, '').trim().split(/\s+/).filter((t) => t.length > 0);
        return {
            text: c.trim(),
            opts: toks.filter((t) => t.indexOf('=') !== -1),
            bare: toks.filter((t) => t.indexOf('=') === -1),
        };
    };
    // (g) the one retention line, its window from one constant.
    const RET_DAYS_3X = '-365d';
    // Groups: 1 the collection read, 2 the field trimmed, 3 the collection written.
    const SHAPE_3X = new RegExp('^\\| inputlookup ([\\w.-]+) \\| where (bucket_ts|day_ts) >= relative_time\\(now\\(\\), "'
        + RET_DAYS_3X + '"\\) \\| outputlookup override_if_empty=false ([\\w.-]+) \\| stats count$');
    // (h) the field each collection declares: exactly one of field.bucket_ts /
    // field.day_ts = number, or null.
    const COLL_3X = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'collections.conf');
    const collBodies3x = {};
    fs.readFileSync(COLL_3X, 'utf8').replace(/\r\n/g, '\n').split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (m) collBodies3x[m[1]] = (collBodies3x[m[1]] || '') + chunk.slice(m[0].length);
    });
    const trimField3x = (c) => {
        const body = collBodies3x[c];
        if (typeof body !== 'string') return null;
        const f = ['bucket_ts', 'day_ts'].filter((k) => confLast(body, `field.${k}`) === 'number');
        return f.length === 1 ? f[0] : null;
    };
    // Another window each, pinned where it is derived: 3r (the IP enrichment:
    // last_seen and its future clamp), 3b and 3f (the Data Doctor pair, from
    // diagPersistence.ts and the platform snapshot's own pins, row caps included).
    const SHAPE_EXEMPT_3X = ['logserv_topology_enrichment_retention', 'logserv_diag_reports_retention',
        'logserv_diag_platform_retention'];
    // (h) ... and each of them line for line. The reports' cap is derived, as in 3b.
    const retMaxRows3x = loadTs(path.join(UTILS, 'diagPersistence')).RETENTION_MAX_ROWS;
    const SHAPE_EXEMPT_LINES_3X = {
        logserv_topology_enrichment_retention: '| inputlookup logserv_topology_ip_enrichment'
            + ' | where last_seen >= relative_time(now(), "-365d") AND last_seen <= now() + 86400'
            + ' | outputlookup override_if_empty=false logserv_topology_ip_enrichment | stats count',
        logserv_diag_reports_retention: '| inputlookup logserv_diag_reports'
            + ' | where generated_at >= relative_time(now(), "-365d") AND generated_at <= now() + 86400'
            + ` | sort ${retMaxRows3x} - generated_at`
            + ' | outputlookup override_if_empty=false logserv_diag_reports | stats count',
        logserv_diag_platform_retention: '| inputlookup logserv_diag_platform_snapshot'
            + ' | where bucket_ts >= relative_time(now(), "-30d") AND bucket_ts <= now() + 86400 AND len(detail) <= 300'
            + ' | sort 120000 - bucket_ts'
            + ' | outputlookup override_if_empty=false logserv_diag_platform_snapshot | stats count',
    };
    let exact3x = 0;
    let shaped3x = 0;
    let all3x = 0;
    let guarded3x = 0;
    let registered3x = 0;
    // (f) collection -> the retentions that read and write it at the top level.
    const trims3x = {};
    ret3x.forEach((n) => {
        const body = bodies3x[n] || '';
        const lines = (body.match(/^[ \t]*search[ \t]*=/gm) || []).length;
        const sm = /^search = (.*)$/m.exec(body);
        p3x(`${n} search line`, lines === 1, `expected exactly one search line, found ${lines}`);
        p3x(`${n} search form`, lines !== 1 || !!sm,
            'the search line must read `search = <spl>` (one space each side of =)');
        const spl = sm ? sm[1] : '';
        const outs = (spl.match(OUT_3X) || []).map(clause3x);
        const ins = (spl.match(IN_3X) || []).map(clause3x);
        // (d) Quoted strings are blanked first, so a `[` or a command word
        // inside a string literal is not counted.
        const bare3x = spl.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        const nIn3x = (bare3x.match(/\binputlookup\b/gi) || []).length;
        const nOut3x = (bare3x.match(/\boutputlookup\b/gi) || []).length;
        p3x(`${n} one collection`, nIn3x === 1 && nOut3x === 1,
            `expected exactly one inputlookup and one outputlookup, found ${nIn3x} + ${nOut3x}`
            + ' - one retention search per collection (session 095)');
        p3x(`${n} top level`, bare3x.indexOf('[') === -1,
            'a `[` outside a quoted string opens a subsearch, whose row and time limits can cut'
            + ' what the retention reads and then writes back');
        // (g) the whole collection is read, and only the window trims it.
        const cut3x = /(?:^|\|)\s*(head|tail|top|rare|sample|dedup|uniq)\b/i.exec(bare3x);
        const where3x = (bare3x.match(/\|\s*where\b/gi) || []).length;
        p3x(`${n} reads whole`, ins.length === 1 && ins[0].opts.length === 0 && ins[0].bare.length === 1
            && where3x === 1 && !cut3x,
            `\`${ins.map((c) => c.text).join(' / ')}\` - a retention reads its collection with no option and no where`
            + ` clause, trims it with one \`| where\` (found ${where3x}) and cuts no rows`
            + (cut3x ? ` (found \`${cut3x[0].trim()}\`)` : '') + ' - the overwrite writes back only what it read');
        if (SHAPE_EXEMPT_3X.indexOf(n) === -1) {
            const sh = SHAPE_3X.exec(spl);
            const same = !!sh && sh[1] === sh[3];
            const declared = same ? trimField3x(sh[1]) : null;
            const ok = same && declared !== null && sh[2] === declared;
            if (ok) shaped3x += 1;
            p3x(`${n} search shape`, ok, same
                ? `trims on ${sh[2]}, but collections.conf [${sh[1]}] declares `
                    + (declared === null ? 'neither (or both) of field.bucket_ts / field.day_ts = number' : `field.${declared} = number`)
                    + ' - a where on a field the rows lack keeps every row, so the collection is never trimmed'
                : `expected exactly \`| inputlookup C | where bucket_ts >= relative_time(now(), "${RET_DAYS_3X}")`
                    + ' | outputlookup override_if_empty=false C | stats count` (day_ts where C declares it) - the'
                    + ` window is the trim; found \`${spl}\``);
        } else {
            const want = SHAPE_EXEMPT_LINES_3X[n];
            const ok = typeof want === 'string' && Number.isInteger(retMaxRows3x) && retMaxRows3x > 0 && spl === want;
            if (ok) exact3x += 1;
            p3x(`${n} search shape`, ok,
                `expected exactly \`${want}\` (row cap ${retMaxRows3x} from diagPersistence.ts) - a stage another`
                + ` pin lets through (search, regex, stats, ...) would drop rows every night; found \`${spl}\``);
        }
        all3x += outs.length;
        if (want3x.indexOf(n) !== -1) registered3x += outs.length;
        outs.forEach((o, i) => {
            const at = `${n} outputlookup ${i + 1} of ${outs.length}`;
            const flag = o.opts.filter((t) => /^override_if_empty=/i.test(t));
            const ok = flag.length === 1 && flag[0] === 'override_if_empty=false';
            if (ok) guarded3x += 1;
            p3x(`${at} override_if_empty`, ok,
                `\`${o.text}\` must carry override_if_empty=false, or an empty read wipes the collection`);
            p3x(`${at} append`, !o.opts.some((t) => /^append=/i.test(t)),
                `\`${o.text}\` must rewrite its collection, not append to it - the trim would delete nothing`);
            p3x(`${at} collection`, o.bare.length === 1, `\`${o.text}\` must name exactly one collection`);
            // (f) the flag and append= have their own pins; nothing else.
            const other = o.opts.filter((x) => !/^(override_if_empty|append)=/i.test(x));
            p3x(`${at} options`, other.length === 0,
                `\`${o.text}\` may carry override_if_empty=false only - found [${other.join(' ')}];`
                + ' max=N keeps N rows and drops the rest of the collection');
        });
        if (nIn3x === 1 && nOut3x === 1 && ins.length === 1 && outs.length === 1 && ins[0].bare[0]
            && outs[0].bare.length === 1 && ins[0].bare[0] === outs[0].bare[0]) {
            (trims3x[ins[0].bare[0]] = trims3x[ins[0].bare[0]] || []).push(n);
        }
        const read = ins.map((c) => c.bare[0] || '?').join(', ');
        const wrote = outs.map((c) => (c.bare.length === 1 ? c.bare[0] : '?')).join(', ');
        p3x(`${n} round trip`, outs.length > 0 && read === wrote,
            `reads [${read}] but writes [${wrote}] - a retention writes back what it read, in the same order`);
    });
    const staleShape3x = SHAPE_EXEMPT_3X.filter((n) => ret3x.indexOf(n) === -1);
    const unlined3x = SHAPE_EXEMPT_3X.filter((n) => typeof SHAPE_EXEMPT_LINES_3X[n] !== 'string')
        .concat(Object.keys(SHAPE_EXEMPT_LINES_3X).filter((n) => SHAPE_EXEMPT_3X.indexOf(n) === -1));
    p3x('shape exemptions', staleShape3x.length === 0 && unlined3x.length === 0,
        [staleShape3x.length ? `SHAPE_EXEMPT_3X names [${staleShape3x.join(', ')}], which the conf does not define`
            + ' - drop the exemption' : '',
        unlined3x.length ? `[${unlined3x.join(', ')}] in only one of SHAPE_EXEMPT_3X and SHAPE_EXEMPT_LINES_3X` : '']
            .filter((s) => s.length > 0).join('; '));
    // (f) coverage, independent of retentionSearches.
    const DIAG_COLL_3X = ['logserv_diag_reports', 'logserv_diag_platform_snapshot'];
    // Not in any completenessCollections, but trimmed by its last_seen.
    const TIMED_EXTRA_3X = ['logserv_topology_ip_enrichment'];
    // Overwritten whole by its own aggregate - no buckets to trim.
    const FLAT_3X = ['logserv_topology_inventory'];
    const rollups3x = registry3x.ROLLUPS || [];
    const timed3x = [].concat(...rollups3x.map((d) => d.completenessCollections || []))
        .concat(TIMED_EXTRA_3X, DIAG_COLL_3X).filter((c, i, a) => a.indexOf(c) === i);
    const allColl3x = [].concat(...rollups3x.map((d) => d.collections || []));
    const unexempt3x = allColl3x.filter((c) => timed3x.indexOf(c) === -1 && FLAT_3X.indexOf(c) === -1);
    const staleFlat3x = FLAT_3X.filter((c) => allColl3x.indexOf(c) === -1);
    p3x('flat collections', timed3x.length > DIAG_COLL_3X.length && unexempt3x.length === 0 && staleFlat3x.length === 0,
        `every registry collection must be time-bucketed (trimmed) or exempted in FLAT_3X - not exempted`
        + ` [${unexempt3x.join(', ')}], exempted but not registered [${staleFlat3x.join(', ')}]`);
    timed3x.forEach((c) => {
        const by = trims3x[c] || [];
        p3x(`${c} one retention`, by.length === 1,
            `expected exactly one [logserv_*_retention] that reads and writes ${c} at the top level, found`
            + ` [${by.join(', ')}] - without one the collection grows without bound`);
    });
    // (e) the schedule: enabled, daily, inside the band.
    const BAND_3X = { from: 0 * 60 + 30, to: 2 * 60 + 36 };
    const hhmm3x = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // Round 4: confLast also reads an indented key.
    const last3x = confLast;
    const ON_3X = /^(1|t|true|yes|on)$/i;
    let latest3x = -1;
    ret3x.forEach((n) => {
        const body = bodies3x[n] || '';
        const cron = last3x(body, 'cron_schedule');
        const cm = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron || '');
        const daily = !!cm && Number(cm[1]) < 60 && Number(cm[2]) < 24;
        const at = daily ? Number(cm[2]) * 60 + Number(cm[1]) : -1;
        if (at > latest3x) latest3x = at;
        const on = ON_3X.test(last3x(body, 'enableSched') || '') && ON_3X.test(last3x(body, 'is_scheduled') || '')
            && !ON_3X.test(last3x(body, 'disabled') || '');
        p3x(`${n} in band`, on && daily && at >= BAND_3X.from && at <= BAND_3X.to,
            `expected an enabled, scheduled daily cron inside ${hhmm3x(BAND_3X.from)}-${hhmm3x(BAND_3X.to)}`
            + ` - found cron_schedule = ${cron}, enableSched = ${last3x(body, 'enableSched')},`
            + ` is_scheduled = ${last3x(body, 'is_scheduled')}, disabled = ${last3x(body, 'disabled')}`);
    });
    const EDGES_3X = 'logserv_topology_edges_retention';
    const edges3x = bodies3x[EDGES_3X] || '';
    p3x(`${EDGES_3X} schedule`, edges3x.length > 0 && last3x(edges3x, 'cron_schedule') === '36 2 * * *'
        && last3x(edges3x, 'enableSched') === '1' && last3x(edges3x, 'is_scheduled') === '1'
        && !ON_3X.test(last3x(edges3x, 'disabled') || ''),
        'expected cron_schedule = 36 2 * * *, enableSched = 1, is_scheduled = 1 and not disabled'
        + ' - re-run the cron census before moving it');
    console.log(`check-diagnostics: 3x ${guarded3x} of ${all3x} retention outputlookup clauses in ${ret3x.length} stanzas`
        + ` (${registered3x} on the ${want3x.length} registered) carry override_if_empty=false; each enabled daily`
        + ` inside ${hhmm3x(BAND_3X.from)}-${hhmm3x(BAND_3X.to)}, the last at ${latest3x < 0 ? 'none' : hhmm3x(latest3x)};`
        + ` ${timed3x.length} time-bucketed collections, each read and written by one retention;`
        + ` ${shaped3x} retentions in the ${RET_DAYS_3X} shape on the field their collection declares,`
        + ` ${exact3x} of ${SHAPE_EXEMPT_3X.length} exempt pinned line for line, each reading whole`);
}

// --- 3y: every overwrite refuses an empty read; the ES feeds run in one pass -
//
// Session 149 (build 376). Section 3x holds the retentions; the ES asset and
// identity feeds are the only other searches that rewrite their target whole,
// and they followed none of its rules: an empty 7-day read deleted the CSV
// that ES Asset & Identity reads, a bare `sort` kept 10,000 rows and dropped
// the rest without a word, and each feed was a `| union` of arms - subsearches
// Splunk finalizes at 30 s / 50,000 rows, so a slow arm wrote a shorter
// inventory. Each feed is now one pipeline. These pins read `search = ` lines
// only, with quoted strings blanked:
//  (a) every outputlookup that is not append=true carries
//      override_if_empty=false, and the stanzas that overwrite are exactly the
//      3x retentions plus the two feeds - a new overwriting search has to be
//      added here on purpose;
//  (b) every `| sort` on a line that writes (any outputlookup) names its
//      count - `sort 0` for every row; a bare sort stops at 10,000;
//  (c) each feed starts from the index macro and has no union / append /
//      appendpipe / appendcols / join / multisearch / map and no `[`;
//  (d) each feed's OWN line ends with the window guard followed by the
//      outputlookup of its own CSV: a run whose window starts later than
//      -6d@d (a short manual dispatch) writes nothing instead of a short
//      inventory. Pinned per feed - a guard on the sibling proves nothing
//      (session 148, convention 4);
//  (e) each feed dispatches over -7d@d..now - the window the guard lets
//      through, and all of it (the guard tests info_min_time only).
// Round 2 (build 376):
//  (b) each feed also sorts exactly once, `sort 0 <fields>`, and has no head
//      or tail in command position - a written count (`sort 10000`) brings
//      the build-375 cap back and still names a count;
//  (f) every stanza with a search key has exactly ONE `search = ` line, not
//      continued with a trailing backslash. Splunk runs the LAST of a
//      repeated key, so a second line would run while the pins read the
//      first (session 148, convention 4); 3y and 3z read the last line.
// Round 3 (build 376):
//  (a) a writing outputlookup carries no option but append=true and
//      override_if_empty=false - max=N keeps N rows; each feed's own
//      outputlookup is exactly `outputlookup override_if_empty=false <csv>`;
//  (b) each feed's `sort 0` is followed by a field, not an option
//      (`sort 0 limit=5`), and no head / tail / top / rare / sample /
//      `dedup <n>` cuts rows in command position;
//  (e) each feed's dispatch.latest_time is now;
//  (f) no stanza header repeats (Splunk merges the blocks; the parse here
//      keeps the last), and no non-comment line ends in a backslash (the
//      next line - a `search = ` - would continue the value before it).
// Round 4 (build 376): every key is read with confLast (the last value, any
// spacing, an indented key too), and every key line of the conf has one
// spelling, `key = value` with the key at column 0 ('key spelling') - Splunk
// also reads `key=value` and takes the last of a repeated key, so a later
// line spelled another way fails here on its own.
{
    const SS_3Y = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'savedsearches.conf');
    const ss3y = fs.readFileSync(SS_3Y, 'utf8').replace(/\r\n/g, '\n');
    const p3y = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3y ${label}: ${detail}`);
            failed = true;
        }
    };
    const bodies3y = {};
    ss3y.split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (m) bodies3y[m[1]] = chunk.slice(m[0].length);
    });
    // The last occurrence, any spacing, as Splunk reads a repeated key.
    const field3y = confLast;
    const esc3y = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The identity feed's "hana_admin|" tags and split(feed_pair, "|") hold
    // pipes that are not commands.
    const unquote3y = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const FEEDS_3Y = {
        splunk_sap_logserv_es_asset_feed: 'splunk_for_sap_logserv_assets.csv',
        splunk_sap_logserv_es_identity_feed: 'splunk_for_sap_logserv_identities.csv',
    };
    const OUT_3Y = /(?:^|\||\[)\s*outputlookup\b[^|\]]*/gi;
    const SORT_3Y = /(?:^|\||\[)\s*sort\b[^|\]]*/gi;
    const retentions3y = Object.keys(bodies3y).filter((n) => /^logserv_\w+_retention$/.test(n));
    const want3y = retentions3y.concat(Object.keys(FEEDS_3Y)).sort();
    const over3y = [];
    let clauses3y = 0;
    let sorts3y = 0;
    // (f) one search line per stanza, conf-wide.
    let searchStanzas3y = 0;
    Object.keys(bodies3y).forEach((n) => {
        const keys = (bodies3y[n].match(/^[ \t]*search[ \t]*=/gm) || []).length;
        if (keys === 0) return;
        searchStanzas3y += 1;
        const lines = bodies3y[n].match(/^search = .*$/gm) || [];
        p3y(`${n} search line`, keys === 1 && lines.length === 1 && !/\\[ \t]*$/.test(lines[0]),
            `expected exactly one \`search = \` line, not continued with a trailing backslash - found ${keys}`
            + ' search key(s); Splunk runs the last of a repeated key');
    });
    // (f) round 3: headers counted in the raw text (the parse collapses them).
    const heads3y = ss3y.match(/^\[[^\]\n]+\][ \t]*$/gm) || [];
    const dupHeads3y = heads3y.filter((h, i) => heads3y.indexOf(h) !== i)
        .filter((h, i, a) => a.indexOf(h) === i).map((h) => h.trim());
    p3y('stanza headers', heads3y.length > 0 && dupHeads3y.length === 0,
        `repeated stanza header(s) ${dupHeads3y.join(', ')} - Splunk merges the blocks, the pins read only the last`);
    const cont3y = ss3y.split('\n').filter((l) => !/^[ \t]*#/.test(l) && /\\[ \t]*$/.test(l));
    p3y('continued lines', cont3y.length === 0,
        `${cont3y.length} non-comment line(s) end in a backslash, which continues the value onto the next line`
        + ` (a following \`search = \` would become part of it): ${cont3y.map((l) => l.slice(0, 60)).join(' / ')}`);
    // Round 4: one spelling for every key line - `key = value`, the key at
    // column 0 (comments, blank lines and stanza headers aside).
    const KEY_LINE_3Y = /^[A-Za-z_][\w.:-]* =( |$)/;
    const odd3y = ss3y.split('\n').filter((l) => l.trim().length > 0 && !/^[ \t]*#/.test(l)
        && !/^\[[^\]\n]+\][ \t]*$/.test(l) && !KEY_LINE_3Y.test(l));
    p3y('key spelling', odd3y.length === 0,
        `${odd3y.length} key line(s) not spelled \`key = value\` from column 0: ${odd3y.map((l) => l.slice(0, 60)).join(' / ')}`
        + ' - Splunk reads them too, and the last of a repeated key wins');
    Object.keys(bodies3y).forEach((n) => {
        const spl = field3y(bodies3y[n], 'search');
        if (spl === null) return;
        const bare = unquote3y(spl);
        const words = (bare.match(/\boutputlookup\b/gi) || []).length;
        const outs = bare.match(OUT_3Y) || [];
        p3y(`${n} outputlookup parse`, words === outs.length,
            `${words} outputlookup word(s) but ${outs.length} outputlookup command(s) - each must follow a | or [`);
        let overwrites = false;
        outs.forEach((c) => {
            const opts = c.replace(/^[|[\s]*outputlookup\b/i, '').trim().split(/\s+/)
                .filter((t) => t.indexOf('=') !== -1);
            const odd = opts.filter((t) => !/^append=true$/i.test(t) && t !== 'override_if_empty=false');
            p3y(`${n} outputlookup options`, odd.length === 0,
                `\`${c.trim()}\` may carry append=true and override_if_empty=false only - found [${odd.join(' ')}];`
                + ' max=N writes N rows');
            if (opts.some((t) => /^append=(t|true|1)$/i.test(t))) return;
            overwrites = true;
            clauses3y += 1;
            const flag = opts.filter((t) => /^override_if_empty=/i.test(t));
            p3y(`${n} override_if_empty`, flag.length === 1 && flag[0] === 'override_if_empty=false',
                `\`${c.trim()}\` rewrites its target whole - it must carry override_if_empty=false,`
                + ' or an empty read deletes it');
        });
        if (overwrites) over3y.push(n);
        if (words > 0) {
            (bare.match(SORT_3Y) || []).forEach((c) => {
                sorts3y += 1;
                p3y(`${n} sort count`, /^[|[\s]*sort\s+(\d+|limit=\d+)(\s|$)/i.test(c),
                    `\`${c.trim()}\` on a line that writes must name its count (sort 0 for every row)`
                    + ' - a bare sort keeps 10,000 rows and drops the rest without a word');
            });
        }
    });
    over3y.sort();
    p3y('overwrite set', JSON.stringify(over3y) === JSON.stringify(want3y),
        `the stanzas that overwrite must be the ${retentions3y.length} retentions + the 2 ES feeds`
        + ` - unexpected [${over3y.filter((n) => want3y.indexOf(n) === -1).join(', ')}],`
        + ` missing [${want3y.filter((n) => over3y.indexOf(n) === -1).join(', ')}]`);
    const GUARD_3Y = '| addinfo | where info_min_time <= relative_time(now(), "-6d@d") | fields - info_*';
    Object.keys(FEEDS_3Y).forEach((n) => {
        const spl = field3y(bodies3y[n], 'search') || '';
        const bare = unquote3y(spl);
        p3y(`${n} present`, spl.length > 0, 'stanza or search line missing');
        p3y(`${n} macro`, spl.startsWith('`sap_logserv_idx_macro` '),
            'the feed must start from the index macro, not a generating command');
        const sub = /(?:^|\|)\s*(union|append\w*|join|multisearch|map)\b/i.exec(bare);
        p3y(`${n} one pass`, !sub,
            `\`${sub ? sub[0].trim() : ''}\` runs part of the feed as a subsearch, finalized at 30 s / 50,000 rows`);
        p3y(`${n} no subsearch`, bare.indexOf('[') === -1, 'a `[` outside a quoted string opens a subsearch');
        const sorts = bare.match(SORT_3Y) || [];
        const cut = /(?:^|\||\[)\s*(head|tail|top|rare|sample|dedup\s+\d+)\b/i.exec(bare);
        p3y(`${n} sort 0`, sorts.length === 1 && /^[|[\s]*sort\s+0\s+(?![\w.]+=)[^\s|\]]/i.test(sorts[0]) && !cut,
            `the feed sorts once, \`sort 0 <fields>\`, and cuts no rows - found [${sorts.map((s) => s.trim()).join(' / ')}]`
            + (cut ? ` and \`${cut[0].trim()}\`` : ''));
        // Its own guard, then its own outputlookup (exactly the flag), at the end.
        const tail = new RegExp(` ${esc3y(GUARD_3Y)} \\| outputlookup override_if_empty=false ${esc3y(FEEDS_3Y[n])}$`);
        p3y(`${n} window guard`, tail.test(spl) && spl.split('| addinfo |').length === 2,
            `the feed's own search line must end with ${GUARD_3Y} | outputlookup override_if_empty=false ${FEEDS_3Y[n]}`);
        p3y(`${n} window`, field3y(bodies3y[n], 'dispatch.earliest_time') === '-7d@d',
            'the feed dispatches over -7d@d - the guard writes nothing for a window that starts after -6d@d');
        // finding 14: the guard tests info_min_time only, so an earlier end
        // would pass it and write a short inventory.
        p3y(`${n} window end`, field3y(bodies3y[n], 'dispatch.latest_time') === 'now',
            'the feed dispatches up to now - an earlier dispatch.latest_time passes the guard and writes a short inventory');
    });
    console.log(`check-diagnostics: 3y ${clauses3y} overwriting outputlookup clauses in ${over3y.length} stanzas`
        + ` (${retentions3y.length} retentions + 2 ES feeds) carry override_if_empty=false;`
        + ` ${sorts3y} sorts on writing lines name a count; both feeds one pass + sort 0 + window guard;`
        + ` ${searchStanzas3y} stanzas, one search line each; ${heads3y.length} stanza headers, none repeated;`
        + ' no continued lines; one key spelling');
}

// --- 3z: the AI Assistant runs catalog saved searches only -----------------
//
// Session 149 (build 376), OWASP LLM06 (Excessive Agency). The App ships
// saved searches that WRITE - every rollup aggregate, backfill and retention,
// and the ES feeds - and App 7931's run_saved_search runs any saved search by
// name, exempt from the server's own SPL check. Until build 375 the assistant
// sent whatever name the model chose, and a model-supplied
// `arguments.saved_search_name` was spread in after the vetted name and
// replaced it. The allow-list is now the intent map, enforced where the call
// is sent; its behaviour is savedSearchAllowList.consistency-test. These pins
// hold the wiring and the conf to it (each module is read and evaluated from
// its own text here, so a control can substitute it):
//  (a) MCPClient.runSavedSearch checks the name against a REQUIRED allow-list
//      before anything is sent and sends exactly buildSavedSearchArgs(name,
//      time) - built key by key, no spread; invokeTool refuses the
//      saved-search tool, so there is no second path;
//  (b) no intent-map stanza writes, deletes, alerts, runs a script or reruns
//      another search, and the only alert actions any of them enables are
//      ES's notable and risk (the ES correlation searches);
//  (c) every stanza whose search has an outputlookup is outside the intent
//      map, and the allow-list built from the intent map refuses each one;
//  (d) splGuard refuses `savedsearch` as a bare word (| savedsearch,
//      from savedsearch:, union savedsearch:, [savedsearch ...]) and map,
//      mcollect, meventcollect, runshellscript and dump as commands;
//  (e) the dispatcher forwards no tool it did not declare: an unknown name is
//      refused, never passed to mcpClient.invokeTool, and the tool loop
//      refuses (with its audit event) before it dispatches.
// Round 2 (build 376): every source pin reads CODE only - the TypeScript
// scanner's comment ranges are removed first (a `//` inside a string, a
// template or a regex literal stays), so a pinned line kept in a comment
// while the live code differs fails. (b) also pins one search line per
// catalog stanza, read as Splunk reads it (the last). (d) also pins the
// inline-comment refusal, ALLOWED_SPL_MACROS = the macros.conf stanzas
// (read here), an unpaired backtick, MLTK `ai` and `deletemodel`, and
// `fit ... into`. (e) counts every .runSavedSearch( in the hook (exactly
// what savedSearchAllowList.consistency-test H10 requires), each with
// ALLOWED_SAVED_SEARCHES as argument 2, and every invokeTool call in every
// .ts / .tsx under pages/home (MCPClient.ts and the tests excepted) passes
// the literal 'splunk_run_query'.
// Round 3 (build 376): the code-only reader keeps JSX text (a `//` there is
// text; a built-in sample pins it). (d) pins the guard's quote handling
// (blankQuotedStrings: an unterminated quote and an escaped quote outside a
// string are refused; the command and fit checks read the blanked copy; a
// quoted command word is refused), the searchbnf.conf aliases (collect:
// stash / summaryindex / sumindex; script: run; savedsearch: macro /
// savedsplunk), rest, the exfil commands and the external lookup dnslookup.
// (e) reads each file's TypeScript syntax tree: invokeTool may name a member
// or be the callee of a call whose first argument is the literal
// 'splunk_run_query' - a destructuring, a ternary branch or an element
// access fails - and outside the hook nothing names runSavedSearch; the hook
// declares ALLOWED_SAVED_SEARCHES once (the module-level const) and calls
// dispatchTool once, after the refusal block.
// Round 4 (build 376): (c) the allow-list is immutable - no add, delete or
// clear, not even through Set.prototype or a reassigned member - and a copy.
// (d) the macro DEFINITIONS (the last `definition` of each macros.conf
// stanza) are read-only SPL the guard passes, with no nested macro and no
// arguments; the guard's round-4 rules are pinned: the forbidden words and
// dnslookup are also read on a copy with every quote character removed, a
// quoted or quote-split command word spells a command or a word, and a fit
// command refuses `into` ANYWHERE later in the query. (e) the hook's
// allow-list is built, on its syntax tree, from the intent map's prompts and
// used only as the allow-list argument of runSavedSearch and vetToolCall;
// the forwarding walk exempts two files by path, not by name, and reads
// .js / .jsx / .mjs / .cjs too. (f) a failed tool call reaches the AI vendor
// only as vendorToolErrorText's status and class: tier1Summary and
// tier2Summary read no error text, the only read of detected.message is the
// dispatcher's local retry test, the three App refusals build their vendor
// text at the refusal site from the reason they just wrote, and markVisible
// wraps only literals and the known vendor-bound values.
{
    const HOME_3Z = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const MCP_3Z = path.join(HOME_3Z, 'components', 'ai', 'mcp', 'MCPClient.ts');
    const HOOK_3Z = path.join(HOME_3Z, 'hooks', 'useAIAssistant.ts');
    const GUARD_3Z = path.join(HOME_3Z, 'utils', 'splGuard.ts');
    const ALLOW_3Z = path.join(HOME_3Z, 'utils', 'savedSearchAllowList.ts');
    const SS_3Z = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'savedsearches.conf');
    const IM_3Z = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'data', 'mcp', 'logserv_intent_map.json');
    const MACROS_3Z = path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'macros.conf');
    const TEST_3Z = path.join(HOME_3Z, 'utils', 'savedSearchAllowList.consistency-test.ts');
    const FWD_ROOT_3Z = HOME_3Z;
    const read3z = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    // Code only: drop the comment ranges the TypeScript scanner finds in
    // the trivia before each token, then every line that held nothing but
    // a comment; a trailing comment's spaces are trimmed.
    const code3z = (src, file) => {
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
            /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const mark = new Uint8Array(src.length + 1);
        const seen = new Set();
        const take = (pos) => {
            if (seen.has(pos)) return;
            seen.add(pos);
            (ts.getLeadingCommentRanges(src, pos) || []).concat(ts.getTrailingCommentRanges(src, pos) || [])
                .forEach((r) => mark.fill(1, r.pos, r.end));
        };
        const visit = (node) => {
            if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
            const kids = node.getChildren(sf);
            // JSX text is text: a `//` or `/*` in it opens no comment.
            if (kids.length === 0) {
                if (node.kind !== ts.SyntaxKind.JsxText) take(node.getFullStart());
            } else {
                kids.forEach(visit);
            }
        };
        visit(sf);
        const out = [];
        let at = 0;
        src.split('\n').forEach((line) => {
            let kept = '';
            let had = false;
            for (let k = 0; k < line.length; k += 1) {
                if (mark[at + k]) had = true;
                else kept += line[k];
            }
            at += line.length + 1;
            if (!had) out.push(line);
            else if (kept.trim().length > 0) out.push(kept.replace(/[ \t]+$/, ''));
        });
        return out.join('\n');
    };
    const mcp3z = code3z(read3z(MCP_3Z), MCP_3Z);
    const hook3z = code3z(read3z(HOOK_3Z), HOOK_3Z);
    const guardSrc3z = read3z(GUARD_3Z);
    const guard3z = code3z(guardSrc3z, GUARD_3Z);
    const allowSrc3z = read3z(ALLOW_3Z);
    const allow3z = code3z(allowSrc3z, ALLOW_3Z);
    const ss3z = read3z(SS_3Z);
    const im3z = JSON.parse(fs.readFileSync(IM_3Z, 'utf8'));
    const p3z = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3z ${label}: ${detail}`);
            failed = true;
        }
    };
    // Round 3: the reader on a built-in sample - comments go, JSX text stays.
    const SELF_IN_3Z = 'const u = "http://a"; // gone\n/* gone */\n'
        + 'export const P = () => <p>// kept {f(1)} /* kept */</p>;\n';
    const SELF_OUT_3Z = 'const u = "http://a";\nexport const P = () => <p>// kept {f(1)} /* kept */</p>;\n';
    const selfGot3z = code3z(SELF_IN_3Z, 'selftest.tsx');
    p3z('code-only reader', selfGot3z === SELF_OUT_3Z,
        `code3z must drop comments and keep JSX text - returned ${JSON.stringify(selfGot3z)}`);
    // Syntax trees (round 3): comments and JSX text are not nodes.
    const K3z = ts.SyntaxKind;
    const ast3z = (src, file) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
        /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX
            : /\.(js|mjs|cjs)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const eachNode3z = (root, fn) => {
        const walk = (n) => {
            fn(n);
            ts.forEachChild(n, walk);
        };
        walk(root);
    };
    // Evaluated from the text read here. The allow-list module and the lexer
    // are import-free; splGuard (build 377) imports exactly one module, the
    // lexer, which is evaluated from its own text first and handed over - any
    // other import fails.
    const evalTs3z = (src, file, deps) => {
        try {
            const js = ts.transpileModule(src, {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
                fileName: file,
            }).outputText;
            const mod = { exports: {} };
            // eslint-disable-next-line no-new-func
            new Function('exports', 'require', 'module', js)(mod.exports, (spec) => {
                if (deps && Object.prototype.hasOwnProperty.call(deps, spec) && deps[spec]) return deps[spec];
                throw new Error(`may not import ${spec}`);
            }, mod);
            return mod.exports;
        } catch (e) {
            p3z(`${path.basename(file)} evaluates`, false, String(e && e.message ? e.message : e));
            return null;
        }
    };
    const LEXER_3Z = path.join(HOME_3Z, 'utils', 'splLexer.ts');
    const lexerSrc3z = read3z(LEXER_3Z);
    const lexerMod3z = evalTs3z(lexerSrc3z, LEXER_3Z);
    const allowMod = evalTs3z(allowSrc3z, ALLOW_3Z);
    const guardMod = evalTs3z(guardSrc3z, GUARD_3Z, { './splLexer': lexerMod3z });
    // From the opener to the first closer after it (a method's or a const
    // arrow's closing line at its own indentation).
    const body3z = (src, opener, closer) => {
        const i = src.indexOf(opener);
        const j = i === -1 ? -1 : src.indexOf(closer, i);
        return j === -1 ? '' : src.slice(i, j + closer.length);
    };
    const canon3z = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));

    // (a) the one place a saved search is sent.
    const run3z = body3z(mcp3z, '    async runSavedSearch(', '\n    }\n');
    p3z('(a) runSavedSearch signature', run3z.startsWith('    async runSavedSearch(\n        name: string,\n'
        + '        allowed: ReadonlySet<string>,\n        time: SavedSearchTimeRange = {},\n'
        + '    ): Promise<Hidden<MCPToolResult>> {\n'),
        'runSavedSearch(name, allowed, time) - the allow-list is a required parameter, with no default');
    const chk3z = run3z.indexOf('        const verdict = checkSavedSearchName(name, allowed);\n'
        + '        if (!verdict.allowed) {\n            return markHidden<MCPToolResult>({\n');
    const send3z = run3z.indexOf('        const result = await this.callTool(TOOL_RUN_SAVED_SEARCH,'
        + ' buildSavedSearchArgs(name, time));\n');
    p3z('(a) check before send', chk3z !== -1 && send3z !== -1 && chk3z < send3z,
        'runSavedSearch must refuse through checkSavedSearchName(name, allowed) and then send exactly'
        + ' this.callTool(TOOL_RUN_SAVED_SEARCH, buildSavedSearchArgs(name, time))');
    p3z('(a) no spread', run3z.length > 0 && run3z.indexOf('...') === -1
        && (run3z.match(/this\.callTool\(/g) || []).length === 1,
        'runSavedSearch sends one call and spreads nothing into its arguments');
    p3z('(a) one sender', (mcp3z.match(/this\.callTool\(TOOL_RUN_SAVED_SEARCH\b/g) || []).length === 1
        && !/['"]splunk_run_saved_search['"]/.test(mcp3z),
        'MCPClient may send the saved-search tool from runSavedSearch only');
    const inv3z = body3z(mcp3z, '    async invokeTool(', '\n    }\n');
    p3z('(a) invokeTool refuses the saved-search tool',
        inv3z.startsWith('    async invokeTool(name: string, args: object): Promise<Hidden<MCPToolResult>> {\n'
            + '        if (name === TOOL_RUN_SAVED_SEARCH) {\n            return markHidden<MCPToolResult>({\n'),
        'invokeTool must refuse splunk_run_saved_search before anything is sent');
    const bsa3z = body3z(allow3z, 'export const buildSavedSearchArgs = (', '\n};\n');
    p3z('(a) arguments built key by key', bsa3z.indexOf('    const out: SavedSearchMcpArgs ='
        + ' { saved_search_name: name, app: LOGSERV_APP };\n') !== -1 && bsa3z.indexOf('...') === -1,
        'buildSavedSearchArgs must start from { saved_search_name: name, app: LOGSERV_APP } and spread nothing');
    if (allowMod) {
        const got = allowMod.buildSavedSearchArgs('logserv_x', {
            earliest_time: '-24h@h', latest_time: 'now', saved_search_name: 'logserv_mc_retention',
            app: 'search', args: 'x', arguments: { saved_search_name: 'logserv_mc_retention' },
        });
        p3z('(a) exact MCP arguments', canon3z(got) === canon3z({
            saved_search_name: 'logserv_x', app: 'splunk_app_sap_logserv', earliest_time: '-24h@h', latest_time: 'now',
        }), `buildSavedSearchArgs returned ${JSON.stringify(got)}`);
    }

    // (b) + (c) against the conf.
    const bodies3z = {};
    ss3z.split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (m) bodies3z[m[1]] = chunk.slice(m[0].length);
    });
    // The last `search = ` line, as Splunk reads a repeated key.
    const search3z = (b) => confLast(b, 'search');
    const unquote3z = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const prompts3z = Array.isArray(im3z.prompts) ? im3z.prompts : [];
    const intent3z = prompts3z.map((p) => (p ? p.savedSearch : undefined)).filter((n) => typeof n === 'string');
    p3z('(b) catalog', intent3z.length > 0 && intent3z.length === prompts3z.length
        && new Set(intent3z).size === intent3z.length,
        `every intent-map prompt names one saved search, each once (${intent3z.length} of ${prompts3z.length})`);
    const CMD_3Z = /(?:^|\||\[)\s*(outputlookup|outputcsv|collect|summaryindex|tscollect|mcollect|meventcollect|sendalert|sendemail|delete|script|runshellscript|run|map|savedsearch|loadjob|dump)\b/i;
    const WORD_3Z = /\b(savedsearch|loadjob)\b/i;
    const ES_ACTIONS_3Z = ['notable', 'risk'];
    const ON_3Z = /^(1|t|true|yes|on)$/i;
    let alerting3z = 0;
    intent3z.forEach((n) => {
        const b = bodies3z[n];
        const spl = search3z(b);
        p3z(`(b) ${n} present`, spl !== null, 'the intent map names a stanza with no `search = ` line');
        if (spl === null) return;
        const keys = (b.match(/^[ \t]*search[ \t]*=/gm) || []).length;
        const lines = b.match(/^search = .*$/gm) || [];
        p3z(`(b) ${n} search line`, keys === 1 && lines.length === 1 && !/\\[ \t]*$/.test(lines[0]),
            `expected exactly one \`search = \` line, not continued with a trailing backslash - found ${keys}`
            + ' search key(s); Splunk runs the last of a repeated key');
        const bare = unquote3z(spl);
        const w = CMD_3Z.exec(bare) || WORD_3Z.exec(bare);
        p3z(`(b) ${n} read-only`, !w, `\`${w ? w[0].trim() : ''}\` - a catalog search may not write, delete,`
            + ' alert, run a script or rerun another search');
        const on = [];
        b.split('\n').forEach((l) => {
            const a = /^action\.(\w+)\s*=\s*(\S*)\s*$/.exec(l);
            if (a && ON_3Z.test(a[2])) on.push(a[1]);
            const list = /^actions\s*=\s*(.*)$/.exec(l);
            if (list) list[1].split(',').map((x) => x.trim()).filter((x) => x).forEach((x) => on.push(x));
        });
        const other = on.filter((a) => ES_ACTIONS_3Z.indexOf(a) === -1);
        p3z(`(b) ${n} actions`, other.length === 0,
            `enables ${other.join(', ')} - a catalog search may raise only ES notable / risk`);
        if (on.length > 0) alerting3z += 1;
    });
    const writers3z = Object.keys(bodies3z).filter((n) => {
        const s = search3z(bodies3z[n]);
        return s !== null && /\boutputlookup\b/i.test(unquote3z(s));
    });
    const inCat3z = writers3z.filter((n) => intent3z.indexOf(n) !== -1);
    p3z('(c) writers outside the catalog', writers3z.length > 0 && inCat3z.length === 0,
        `the intent map names writing stanza(s) [${inCat3z.join(', ')}] (of ${writers3z.length} writers)`);
    if (allowMod) {
        const allowed3z = allowMod.buildAllowedSavedSearches(prompts3z);
        const through = writers3z.filter((n) => allowMod.checkSavedSearchName(n, allowed3z).allowed !== false);
        p3z('(c) allow-list refuses every writer', through.length === 0,
            `checkSavedSearchName lets through [${through.join(', ')}]`);
        const lost = intent3z.filter((n) => allowMod.checkSavedSearchName(n, allowed3z).allowed !== true);
        p3z('(c) allow-list keeps the catalog', lost.length === 0 && allowed3z.size === intent3z.length,
            `the allow-list must be the ${intent3z.length} catalog searches exactly - refused [${lost.join(', ')}],`
            + ` size ${allowed3z.size}`);
        // Round 4: immutable, on a fresh one. A cast finds no add / delete /
        // clear, Set's own methods refuse it as a receiver, a reassigned
        // member does not take, and it is a copy of the prompts it was built from.
        const src3z = prompts3z.map((p) => Object.assign({}, p));
        const fresh = allowMod.buildAllowedSavedSearches(src3z);
        const throwsType = (f) => {
            try {
                f();
                return false;
            } catch (e) {
                return e instanceof TypeError;
            }
        };
        const noThrow = [
            ['add', () => fresh.add('s149_x')],
            ['delete', () => fresh.delete(intent3z[0])],
            ['clear', () => fresh.clear()],
            ['Set.prototype.add', () => Set.prototype.add.call(fresh, 's149_x')],
            ['Set.prototype.delete', () => Set.prototype.delete.call(fresh, intent3z[0])],
            ['Set.prototype.clear', () => Set.prototype.clear.call(fresh)],
        ].filter(([, f]) => !throwsType(f)).map(([k]) => k);
        try {
            fresh.has = () => true;
        } catch (e) {
            // a frozen object may refuse it loudly; either way it must not take
        }
        src3z.push({ savedSearch: 's149_pushed_later' });
        if (src3z[0]) src3z[0].savedSearch = 's149_y';
        const held = fresh.size === intent3z.length && intent3z.every((n) => fresh.has(n))
            && !fresh.has('s149_x') && !fresh.has('s149_y') && !fresh.has('s149_pushed_later');
        const bas3z = body3z(allow3z, 'export const buildAllowedSavedSearches = (', '\n};\n');
        const rom3z = body3z(allow3z, 'const readOnlyNames = (', '\n};\n');
        p3z('(c) allow-list immutable', noThrow.length === 0 && Object.isFrozen(fresh) && held
            && bas3z.indexOf('    return readOnlyNames(out);\n') !== -1 && rom3z.indexOf('    return Object.freeze(view);\n') !== -1,
            `buildAllowedSavedSearches must return readOnlyNames(out), a frozen view with no add / delete / clear -`
            + ` did not throw a TypeError: [${noThrow.join(', ')}], frozen ${Object.isFrozen(fresh)},`
            + ` unchanged after the attempts and a change to its prompts ${held}`);
    }

    // (d) splGuard, on its text and evaluated.
    const cmds3z = /export const FORBIDDEN_SPL_COMMANDS = \[([\s\S]*?)\] as const;/.exec(guard3z);
    const list3z = cmds3z ? (cmds3z[1].replace(/\/\/[^\n]*/g, '').match(/'([a-z]+)'/g) || [])
        .map((q) => q.slice(1, -1)) : [];
    // Round 3: with every alias Splunk 9.4.3's system/default/searchbnf.conf
    // declares for them (collect L4435, script L3760, savedsearch L3793).
    const NEED_3Z = ['collect', 'stash', 'summaryindex', 'sumindex', 'mcollect', 'meventcollect', 'outputlookup',
        'outputcsv', 'outputtext', 'delete', 'sendalert', 'sendemail', 'script', 'run', 'runshellscript', 'dump',
        'tscollect', 'createrss', 'rest', 'outputtelemetry', 'curl', 'wget', 'sendresults', 'ai', 'deletemodel',
        'macro', 'savedsplunk', 'map'];
    const lack3z = NEED_3Z.filter((c) => list3z.indexOf(c) === -1);
    const dup3z = list3z.filter((c, i) => list3z.indexOf(c) !== i);
    const quoted3z = cmds3z ? (cmds3z[1].match(/'[^'\n]*'/g) || []).length : 0;
    p3z('(d) commands', lack3z.length === 0 && dup3z.length === 0 && quoted3z === list3z.length
        && list3z[list3z.length - 1] === 'map',
        `FORBIDDEN_SPL_COMMANDS lacks [${lack3z.join(', ')}], repeats [${dup3z.join(', ')}],`
        + ` has ${quoted3z - list3z.length} entry(ies) that are not lowercase letters, ends with`
        + ` '${list3z[list3z.length - 1]}' - 'map' stays last`);
    p3z('(d) bare word', guard3z.indexOf("export const FORBIDDEN_SPL_WORDS = [\n    'savedsearch',\n    'savedsplunk',\n] as const;") !== -1
        && guard3z.indexOf("`\\\\b(${FORBIDDEN_SPL_WORDS.join('|')})\\\\b`,\n    'gi',") !== -1
        && guard3z.indexOf("`(?:^|\\\\||\\\\[)\\\\s*(${FORBIDDEN_SPL_COMMANDS.join('|')})\\\\b`,\n    'gi',") !== -1
        && guard3z.indexOf('    FORBIDDEN_RE.lastIndex = 0;\n    FORBIDDEN_WORD_RE.lastIndex = 0;\n'
            + '    const match = FORBIDDEN_RE.exec(unquoted) ?? FORBIDDEN_WORD_RE.exec(query);\n') !== -1,
        'savedsearch and savedsplunk must be refused as bare words anywhere in the raw query (FORBIDDEN_SPL_WORDS),'
        + ' the commands after start, | or [ outside quoted strings - and analyzeSpl must try both');
    // Round 2: an inline comment hides words from every other check, so it
    // is refused first; macros are the App's own (the macros.conf stanzas,
    // derived here) and every backtick pair is checked; fit ... into saves
    // a model.
    const iCom3z = guard3z.indexOf('    if (query.indexOf(INLINE_COMMENT) !== -1) {\n        return refuse(\n'
        + '            OPERATOR_INLINE_COMMENT,');
    const iCmd3z = guard3z.indexOf('    const match = FORBIDDEN_RE.exec(unquoted) ?? FORBIDDEN_WORD_RE.exec(query);');
    p3z('(d) inline comment', guard3z.indexOf("const INLINE_COMMENT = '```';") !== -1 && iCom3z !== -1 && iCmd3z > iCom3z,
        'analyzeSpl must refuse any ``` (an SPL inline comment) before its command and word scan');
    const macroConf3z = read3z(MACROS_3Z).split('\n').map((l) => /^\[(.+)\]\s*$/.exec(l.trim()))
        .filter((m) => m).map((m) => m[1]);
    const macroList3z = guardMod && Array.isArray(guardMod.ALLOWED_SPL_MACROS) ? guardMod.ALLOWED_SPL_MACROS.slice() : [];
    p3z('(d) macros', macroConf3z.length > 0
        && JSON.stringify(macroList3z.slice().sort()) === JSON.stringify(macroConf3z.slice().sort())
        && guard3z.indexOf('    allowed: readonly string[] = ALLOWED_SPL_MACROS,\n') !== -1
        && guard3z.indexOf("    const parts = query.split('`');\n    if (parts.length % 2 === 0) {\n        return refuse(\n"
            + '            OPERATOR_UNBALANCED_BACKTICK,') !== -1
        && guard3z.indexOf('    for (let i = 1; i < parts.length; i += 2) {\n        if (!macroReferenceAllowed(parts[i])) {\n'
            + '            return refuse(\n                OPERATOR_MACRO,') !== -1,
        `ALLOWED_SPL_MACROS [${macroList3z.join(', ')}] must be the macros.conf stanzas [${macroConf3z.join(', ')}],`
        + ' an unpaired backtick refused and every backtick pair checked against it');
    // Round 4: the DEFINITIONS. The guard passes an allowed macro by name and
    // Splunk expands it afterwards; 3y and (b) read SPL unexpanded. So each
    // stanza's last `definition` must be SPL the guard passes, with no command
    // or word the catalog pins refuse, no nested macro, and no arguments.
    // Round 5 (round-4 finding 4): and no eval expression - with a truthy
    // iseval Splunk evaluates the definition and expands the resulting string,
    // so a writer inside one quoted literal (blanked by every check here)
    // would pass; any iseval but 0 / false / f / no / n / off is refused, and
    // so is an `args` key in any stanza.
    const macroText3z = read3z(MACROS_3Z);
    const macroDefs3z = {};
    const macroMeta3z = {};
    macroText3z.split(/^(?=\[)/m).forEach((chunk) => {
        const m = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (m) {
            const b = chunk.slice(m[0].length);
            macroDefs3z[m[1]] = confLast(b, 'definition');
            macroMeta3z[m[1]] = { iseval: confLast(b, 'iseval'), args: confLast(b, 'args') };
        }
    });
    const macroCont3z = macroText3z.split('\n').filter((l) => !/^[ \t]*#/.test(l) && /\\[ \t]*$/.test(l)).length;
    const macroBad3z = [];
    Object.keys(macroDefs3z).forEach((n) => {
        const d = macroDefs3z[n];
        const why = [];
        if (/\(\d+\)$/.test(n)) why.push('takes arguments');
        const meta = macroMeta3z[n] || {};
        if (meta.iseval !== null && meta.iseval !== undefined && !/^(0|false|f|no|n|off)$/i.test(meta.iseval)) {
            why.push(`is an eval expression (iseval = ${meta.iseval})`);
        }
        if (meta.args !== null && meta.args !== undefined) why.push(`declares args = ${meta.args}`);
        if (typeof d !== 'string' || d.length === 0) {
            why.push('no definition');
        } else {
            if (d.indexOf('`') !== -1) why.push('references a macro');
            const r = guardMod ? guardMod.analyzeSpl(d) : null;
            if (!r || r.blocked !== false) why.push(`splGuard refuses it (${r ? r.operator : 'no guard'})`);
            const bare = unquote3z(d);
            const w = CMD_3Z.exec(bare) || WORD_3Z.exec(bare);
            if (w) why.push(`\`${w[0].trim()}\``);
        }
        if (why.length > 0) macroBad3z.push(`${n}: ${why.join(', ')}`);
    });
    p3z('(d) macro definitions', Object.keys(macroDefs3z).length > 0 && macroCont3z === 0 && macroBad3z.length === 0,
        `[${macroBad3z.join(' / ')}]${macroCont3z ? `, ${macroCont3z} continued line(s)` : ''} - every App macro must`
        + ' expand to read-only SPL the guard passes: not an eval expression (iseval), no nested macro, no arguments');
    // Round 4: fitThenInto - a fit command word (plain, quoted, split by
    // quotes) at a command position of the blanked copy, then `into` anywhere
    // later in the query, with the quotes removed or made spaces.
    const fti3z = body3z(guard3z, 'const fitThenInto = (query: string, unquoted: string): boolean => {\n', '\n};\n');
    p3z('(d) fit into', guard3z.indexOf('const FIT_WORD_RE = /^fit\\b/i;') !== -1
        && guard3z.indexOf('const INTO_WORD_RE = /\\binto\\b/i;') !== -1
        && fti3z.indexOf("        if (FIT_WORD_RE.test(unquoted.slice(at)) || (tok !== null && FIT_WORD_RE.test(removeQuoteChars(tok[0])))) {\n"
            + '            const rest = query.slice(at);\n'
            + "            return INTO_WORD_RE.test(removeQuoteChars(rest)) || INTO_WORD_RE.test(rest.replace(QUOTE_CHARS_RE, ' '));\n") !== -1
        && guard3z.indexOf('    if (fitThenInto(query, unquoted)) {\n        return refuse(\n            OPERATOR_FIT_INTO,') !== -1,
        'analyzeSpl must refuse MLTK fit ... into through fitThenInto: a fit command word, plain, quoted or split by'
        + ' quotes, then the word into anywhere later in the query (quotes removed, or made spaces)');
    // Round 4: the quote-removed copy - the forbidden words read on it too,
    // and a quoted command word that spells a command or a word is refused.
    const qfc3z = body3z(guard3z, 'const quotedForbiddenCommand = (query: string, unquoted: string): string | null => {\n', '\n};\n');
    const qSplit4z = guard3z.indexOf('    FORBIDDEN_WORD_RE.lastIndex = 0;\n    const splitWord = FORBIDDEN_WORD_RE.exec(dequoted);\n'
        + '    if (splitWord) {\n        return refuseCommand(splitWord[1].toLowerCase());\n    }\n');
    const qDeq3z = guard3z.indexOf('    const unquoted = scan.text;\n    const dequoted = removeQuoteChars(query);\n');
    const qMatch3z = guard3z.indexOf('    const match = FORBIDDEN_RE.exec(unquoted) ?? FORBIDDEN_WORD_RE.exec(query);');
    const qQc3z = guard3z.indexOf('    const quotedCommand = quotedForbiddenCommand(query, unquoted);\n');
    p3z('(d) quote-removed copy', guard3z.indexOf("const QUOTE_CHARS_RE = /[\"']/g;") !== -1
        && guard3z.indexOf("const HAS_QUOTE_RE = /[\"']/;") !== -1
        && guard3z.indexOf("const removeQuoteChars = (text: string): string => text.replace(QUOTE_CHARS_RE, '');") !== -1
        && qDeq3z !== -1 && qMatch3z > qDeq3z && qSplit4z > qMatch3z && qQc3z > qSplit4z
        && guard3z.indexOf("const FORBIDDEN_COMMAND_WORD_RE = new RegExp(\n"
            + "    `^(${[...FORBIDDEN_SPL_COMMANDS, ...FORBIDDEN_SPL_WORDS].join('|')})\\\\b`,\n    'i',\n);") !== -1
        && qfc3z.indexOf('        if (tok && HAS_QUOTE_RE.test(tok[0])) {\n') !== -1
        && qfc3z.indexOf('FORBIDDEN_COMMAND_WORD_RE.exec(removeQuoteChars(tok[0]))') !== -1,
        'analyzeSpl must also read the forbidden words on the query with every double and single quote character'
        + ' removed (dequoted, after the raw match and before the quoted-command check), and quotedForbiddenCommand'
        + ' must read any quoted command word with its quotes removed against the commands AND the words');
    // Round 3: quoted text is data. The order: backtick split, quote scan
    // (unterminated, then escaped quote), the blanked copy, the command /
    // word match, the quoted-command-word check.
    const qSplit3z = guard3z.indexOf("    const parts = query.split('`');\n");
    const qScan3z = guard3z.indexOf('    const scan = blankQuotedStrings(query);\n    if (scan.unterminated) {\n'
        + '        return refuse(\n            OPERATOR_UNTERMINATED_QUOTE,');
    const qEsc3z = guard3z.indexOf('    if (scan.escapedQuote) {\n        return refuse(\n            OPERATOR_ESCAPED_QUOTE,');
    const qText3z = guard3z.indexOf('    const unquoted = scan.text;\n');
    const qCmd3z = guard3z.indexOf('    const quotedCommand = quotedForbiddenCommand(query, unquoted);\n'
        + '    if (quotedCommand !== null) {\n        return refuseCommand(quotedCommand);\n    }\n');
    p3z('(d) quotes', qSplit3z !== -1 && qSplit3z < qScan3z && qScan3z < qEsc3z && qEsc3z < qText3z
        && qText3z < iCmd3z && iCmd3z < qCmd3z
        && guard3z.indexOf('const COMMAND_POSITION_RE = /(?:\\||\\[|^)\\s*/g;') !== -1,
        'analyzeSpl must scan quotes with blankQuotedStrings after the backtick split, refuse an unterminated'
        + ' and an escaped quote, match commands on the blanked copy and then refuse a quoted command word');
    const xRule3z = guard3z.indexOf('    if (EXTERNAL_LOOKUP_RE.test(query) || EXTERNAL_LOOKUP_RE.test(dequoted)) {\n'
        + '        return refuse(\n            OPERATOR_EXTERNAL_LOOKUP,');
    p3z('(d) external lookup', guard3z.indexOf("export const EXTERNAL_LOOKUPS = [\n    'dnslookup',\n] as const;") !== -1
        && guard3z.indexOf("const EXTERNAL_LOOKUP_RE = new RegExp(\n    `\\\\b(${EXTERNAL_LOOKUPS.join('|')})\\\\b`,\n"
            + "    'i',\n);") !== -1
        && xRule3z !== -1 && xRule3z > qCmd3z,
        'analyzeSpl must refuse the external lookup dnslookup as a word anywhere in the raw query or in its'
        + ' quote-removed copy (EXTERNAL_LOOKUPS, EXTERNAL_LOOKUP_RE)');
    if (guardMod) {
        const bq = typeof guardMod.blankQuotedStrings === 'function' ? guardMod.blankQuotedStrings : null;
        const scanCases = [
            ['a "b|c" d', { text: 'a "   " d', unterminated: false, escapedQuote: false }],
            ['a "x\\"y" b', { text: 'a "    " b', unterminated: false, escapedQuote: false }],
            ['a "b\\\\" c', { text: 'a "   " c', unterminated: false, escapedQuote: false }],
            ['a "b', { text: '', unterminated: true, escapedQuote: false }],
            ['a \\"b\\" c', { text: '', unterminated: false, escapedQuote: true }],
        ];
        const wrong = scanCases.filter(([q, want]) => !bq || canon3z(bq(q)) !== canon3z(want)).map(([q]) => q);
        p3z('(d) quote scan', !!bq && wrong.length === 0,
            `blankQuotedStrings must blank quoted content (escapes honoured, length kept) and flag an`
            + ` unterminated or an escaped quote - wrong on [${wrong.join(' / ')}]`);
    }
    if (guardMod) {
        [
            ['| savedsearch logserv_mc_retention', 'savedsearch'],
            ['| from savedsearch:logserv_mc_retention', 'savedsearch'],
            ['| union savedsearch:logserv_mc_retention', 'savedsearch'],
            ['index=main [savedsearch logserv_mc_retention]', 'savedsearch'],
            ['| makeresults | map maxsearches=1 search="search index=main"', 'map'],
            ['| makeresults | mcollect index=m', 'mcollect'],
            ['| makeresults | meventcollect index=m', 'meventcollect'],
            ['| runshellscript x.sh', 'runshellscript'],
            ['| makeresults | dump basefilename=x', 'dump'],
            ['| makeresults | append [| outputlookup logserv_mc_rollup]', 'outputlookup'],
            ['| saved```x```search logserv_mc_retention', 'inline_comment'],
            ['| ```c``` outputlookup x', 'inline_comment'],
            ['| m```x```ap search="x"', 'inline_comment'],
            ['| from saved```x```search:foo', 'inline_comment'],
            ['| saved`comment("x")`search foo', 'macro'],
            ['`evil`', 'macro'],
            ['`evil(1)`', 'macro'],
            ['`sap_logserv_idx_macro` | head 1 | append [`evil`]', 'macro'],
            ['`sap_logserv_idx_macro | stats count', 'unbalanced_backtick'],
            ['| fit DensityFunction count into app:x', 'fit_into'],
            ['| ai prompt="x"', 'ai'],
            ['| deletemodel x', 'deletemodel'],
            // round 3
            ['| makeresults | appendpipe [| savedsplunk logserv_topology_edges_retention]', 'savedsplunk'],
            ['| from savedsplunk:logserv_mc_retention', 'savedsplunk'],
            ['| from "savedsearch:logserv_mc_retention"', 'savedsearch'],
            ['| rest /servicesNS/-/-/storage/passwords | stats count by clear_password', 'rest'],
            ['| makeresults | outputtext', 'outputtext'],
            ['| makeresults | createrss path=x name=y link=z descr=d count=1', 'createrss'],
            ['| curl method=post uri=https://example.invalid data=x', 'curl'],
            ['| makeresults | wget url=https://example.invalid', 'wget'],
            ['| makeresults | outputtelemetry input=x', 'outputtelemetry'],
            ['| makeresults | sendresults', 'sendresults'],
            ['| makeresults | lookup dnslookup clienthost', 'external_lookup'],
            ['| makeresults | eval h=lookup("dnslookup", json_object("clienthost", "a"))', 'external_lookup'],
            ['| makeresults count=10 | eval x=random(), "a|b"=1 | fit DensityFunction x by "a|b" into app:evil_model',
                'fit_into'],
            ['| makeresults | eval x=1, "y]"=2 | fit LinearRegression x from "y]" into app:evil', 'fit_into'],
            ['| search "abc', 'unterminated_quote'],
            ['index=main x=\\"y\\"', 'escaped_quote'],
            ['| "delete"', 'delete'],
            ['| de"lete"', 'delete'],
            ['| makeresults | append [| "outputlookup" logserv_mc_rollup]', 'outputlookup'],
            // round 4: quotes cannot split a word or end the fit scan
            ['| makeresults count=10 | eval x=random() | fit DensityFunction x by "a into b"', 'fit_into'],
            ["| makeresults count=10 | eval 'a|b'=random() | fit DensityFunction 'a|b' into app:evil_model", 'fit_into'],
            ["| makeresults count=10 | eval 'a]b'=random() | fit DensityFunction 'a]b' into app:evil_model", 'fit_into'],
            ['| "saved"search logserv_mc_retention', 'savedsearch'],
            ['| sav"edsearch" x', 'savedsearch'],
            ['| from "saved"search:logserv_mc_retention', 'savedsearch'],
            ['| lookup "dns"lookup clienthost', 'external_lookup'],
            ['| makeresults | fit X "in"to app:m', 'fit_into'],
            ["| 'delete'", 'delete'],
            ['| "fit" X into app:m', 'fit_into'],
            ['| makeresults | eval x=a"savedsearch"b', 'savedsearch'],
        ].concat([].concat(...['stash', 'summaryindex', 'sumindex', 'run', 'macro', 'savedsplunk']
            .map((c) => [[`| ${c} x`, c], [`index=main [${c} x]`, c]]))).forEach(([q, op]) => {
            const r = guardMod.analyzeSpl(q);
            p3z(`(d) blocks ${q}`, !!r && r.blocked === true && r.operator === op,
                `expected operator ${op}, analyzeSpl returned ${JSON.stringify(r)}`);
        });
        [
            'index=main sourcetype=x | stats count by savedsearch_name',
            '| tstats count where index=main by sourcetype',
            '| inputlookup logserv_mc_rollup | stats sum(count) as n',
            '| fit DensityFunction count',
            '| apply m',
            '`sap_logserv_idx_macro` | eval fitness=1',
            '| tstats count WHERE `sap_logserv_idx_macro` by sourcetype',
            '`sap_logserv_audit_idx_macro` | stats count',
            '`sap_logserv_idx_macro` | `sap_logserv_cloud_provider_default_macro` | stats count by cloud_provider',
            // round 3: quoted text is data
            '| rex field=_raw "(?<tag>[AI])"',
            'search "[DELETE]"',
            '| makeresults | eval x="a | collect index=main"',
            '| makeresults | eval rest_time=1',
            '| makeresults | eval dnslookup_cache=1',
            // round 4: apostrophes and quoted names that spell nothing forbidden
            '| makeresults | eval x="don\'t"',
            "| makeresults | eval 'saved search'=1",
            "| makeresults | eval dns='lookup'",
            '| makeresults count=10 | eval x=random() | fit DensityFunction x | eval into_n=1',
        ].forEach((q) => {
            const r = guardMod.analyzeSpl(q);
            p3z(`(d) passes ${q}`, !!r && r.blocked === false, `analyzeSpl returned ${JSON.stringify(r)}`);
        });
    }

    // (g) Build 377: the allow-list for ad-hoc SPL (analyzeAdHocSpl in
    // utils/splGuard.ts, the strict lexer utils/splLexer.ts) and the
    // search-parser check (components/ai/splParserCheck.ts), on the modules
    // evaluated from their text above. The command list is pinned here: an
    // addition is a review (ALLOWED_3Z, both primers and the docs together).
    // union is off it (user decision after the live parser probe P2: Splunk's
    // search parser reports a union rewritten - as append or multisearch - so
    // the parser agreement would refuse every one): refused by name, append
    // suggested.
    const ALLOWED_3Z = [
        'search', 'where', 'eval', 'stats', 'eventstats', 'streamstats', 'tstats', 'chart', 'timechart', 'top',
        'rare', 'sort', 'head', 'tail', 'dedup', 'reverse', 'table', 'fields', 'rename', 'fillnull',
        'filldown', 'bin', 'bucket', 'rex', 'regex', 'spath', 'lookup', 'inputlookup', 'makeresults',
        'addinfo', 'transaction', 'convert', 'iplocation', 'strcat', 'xyseries', 'untable', 'transpose',
        'fieldsummary', 'addtotals', 'addcoltotals', 'makemv', 'nomv', 'mvcombine', 'append', 'appendcols',
        'join', 'appendpipe',
    ];
    const EXCLUDED_3Z = ['logserv_backfill_stage', 'logserv_diag_platform_snapshot', 'logserv_diag_reports',
        'splunk_for_sap_logserv_assets', 'splunk_for_sap_logserv_identities'];
    const PC_3Z = path.join(HOME_3Z, 'components', 'ai', 'splParserCheck.ts');
    if (guardMod && lexerMod3z && typeof guardMod.analyzeAdHocSpl === 'function') {
        const al3z = Array.isArray(guardMod.ALLOWED_SPL_COMMANDS) ? guardMod.ALLOWED_SPL_COMMANDS.slice() : [];
        const deny3z = list3z.concat(['savedsearch', 'savedsplunk', 'dnslookup']);
        p3z('(g) command allow-list', JSON.stringify(al3z) === JSON.stringify(ALLOWED_3Z)
            && al3z.every((c) => deny3z.indexOf(c) === -1),
            `ALLOWED_SPL_COMMANDS [${al3z.join(', ')}] must be the reviewed list (ALLOWED_3Z) and share nothing with the`
            + ' denylist - an addition is a review: update ALLOWED_3Z, both primers and the docs together');
        const PRIMER_LIST_3Z = `'Allowed commands: ${ALLOWED_3Z.join(', ')}.\\n' +`;
        const primerLines3z = hook3z.split('\n').map((l) => l.trim()).filter((l) => l.indexOf("'Allowed commands: ") === 0);
        p3z('(g) primers list the allow-list', primerLines3z.length === 2 && primerLines3z.every((l) => l === PRIMER_LIST_3Z),
            `${primerLines3z.length} 'Allowed commands:' literal(s) in the hook - each system primer lists ALLOWED_SPL_COMMANDS`
            + ' word for word, in one string literal');
        const tfLk3z = [];
        read3z(path.join(__dirname, '..', 'src', 'main', 'resources', 'splunk', 'default', 'transforms.conf'))
            .split(/^(?=\[)/m).forEach((chunk) => {
                const h = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
                if (h && /^(?:filename|collection)\s*=/m.test(chunk.slice(h[0].length))) tfLk3z.push(h[1]);
            });
        const lk3z = Array.isArray(guardMod.ALLOWED_SPL_LOOKUPS) ? guardMod.ALLOWED_SPL_LOOKUPS.slice().sort() : [];
        const wantLk3z = tfLk3z.filter((l) => EXCLUDED_3Z.indexOf(l) === -1).sort();
        p3z('(g) lookup allow-list', tfLk3z.length > 0 && JSON.stringify(lk3z) === JSON.stringify(wantLk3z)
            && JSON.stringify(Array.from(guardMod.EXCLUDED_SPL_LOOKUPS || [])) === JSON.stringify(EXCLUDED_3Z),
            `ALLOWED_SPL_LOOKUPS must be the transforms.conf lookup stanzas (filename / collection) minus [${EXCLUDED_3Z.join(', ')}]`
            + ` - missing [${wantLk3z.filter((l) => lk3z.indexOf(l) === -1).join(', ')}], extra [${lk3z.filter((l) => wantLk3z.indexOf(l) === -1).join(', ')}]`);
        p3z('(g) macro definitions expanded', Object.keys(macroDefs3z).length > 0
            && canon3z(lexerMod3z.APP_MACRO_DEFINITIONS) === canon3z(macroDefs3z),
            'APP_MACRO_DEFINITIONS (utils/splLexer.ts) must be the last definition of each macros.conf stanza');
        const catBad3z = prompts3z.filter((p) => !p || typeof p.spl !== 'string' || guardMod.analyzeAdHocSpl(p.spl).blocked !== false)
            .map((p) => (p ? p.savedSearch : '?'));
        p3z('(g) catalog passes the allow-list', prompts3z.length > 0 && catBad3z.length === 0,
            `[${catBad3z.join(', ')}] - every catalog search must pass analyzeAdHocSpl`);
        [
            ['index=main | stats count', 'index_not_allowed'],
            ['`sap_logserv_idx_macro` OR index=main', 'index_not_allowed'],
            ['`sap_logserv_idx_macro` OR sourcetype=x', 'index_not_allowed'],
            ['`sap_logserv_audit_idx_macro` | stats count', 'index_not_allowed'],
            ['`sap_logserv_idx_macro` | fit DensityFunction count', 'command_not_allowed'],
            ['`sap_logserv_idx_macro` | foreign_custom_command x=1', 'command_not_allowed'],
            ['`sap_logserv_idx_macro` | stats count | tstats append=t prestats=t count where sourcetype=x', 'query_start'],
            ['sourcetype=x | stats count', 'query_start'],
            ['| inputlookup logserv_ai_models', 'lookup_not_allowed'],
            ['| inputlookup logserv_diag_reports', 'lookup_not_allowed'],
            ['`sap_logserv_idx_macro` | eval x=lookup("logserv_mc_rollup", json_object("a",1))', 'eval_lookup'],
            ['`sap_logserv_idx_macro` | eval x=lookup ("logserv_mc_rollup", json_object("a",1))', 'eval_lookup'],
            ['`sap_logserv_idx_macro` [search `sap_logserv_idx_macro` | stats count by host | fields search]', 'subsearch_fields'],
            ['| union datamodel:Authentication', 'command_not_allowed'],
            ["`sap_logserv_idx_macro` don't | rename user AS w | stats count by w | where w!=\"won't\"", 'ambiguous_single_quote'],
            ['`sap_logserv_idx_macro` | stats count by host | where host=`sap_logserv_idx_macro`', 'macro_position'],
            ['| makeresults | collect index=main', 'collect'],
            // Security review of build 377: Splunk reads `\|` as no command boundary, expands a macro as text,
            // and may not group a quoted option value before a lookup's name.
            ['`sap_logserv_idx_macro` | append [search `sap_logserv_idx_macro` host=* \\| appendpipe [search sourcetype=x | fields user]] | stats count', 'escaped_outside_quotes'],
            ['`sap_logserv_idx_macro`* | stats count by index', 'macro_position'],
            ['| tstats count where`sap_logserv_idx_macro` by index', 'macro_position'],
            ['`sap_logserv_idx_macro` | append [search `sap_logserv_idx_macro`_archive | stats count by index]', 'macro_position'],
            ["`sap_logserv_idx_macro` | lookup event_time_field='x logserv_diag_reports report_id ' logserv_mc_rollup host", 'lookup_not_allowed'],
            ['| inputlookup logserv_mc_rollup"_x"', 'lookup_not_allowed'],
        ].forEach(([q, op]) => {
            const r = guardMod.analyzeAdHocSpl(q);
            p3z(`(g) refuses ${q}`, !!r && r.blocked === true && r.operator === op,
                `expected operator ${op}, analyzeAdHocSpl returned ${JSON.stringify(r)}`);
        });
        // union (P2): refused by name before the parser is asked, with a reason
        // that says to use append; it is no subsearch host, no start command and
        // no operator of its own, and the primers name it only to refuse it.
        const union3z = [
            '| union [search `sap_logserv_idx_macro` sourcetype=a | stats count] [| inputlookup logserv_mc_rollup | stats count]',
            '| union [search `sap_logserv_idx_macro` sourcetype=a] [search `sap_logserv_idx_macro` sourcetype=b] | stats count by sourcetype',
            '| union [search `sap_logserv_idx_macro` sourcetype=a | stats count by host] [search `sap_logserv_idx_macro` sourcetype=b'
                + ' | stats count by host] | stats sum(count) by host',
            '`sap_logserv_idx_macro` | append [| union [search `sap_logserv_idx_macro` sourcetype=a] [search `sap_logserv_idx_macro`'
                + ' sourcetype=b]] | stats count',
        ].map((q) => [q, guardMod.analyzeAdHocSpl(q)]).filter(([, r]) => !r || r.blocked !== true
            || r.operator !== 'command_not_allowed' || r.command !== 'union'
            || !/To combine two searches, use append: <first search> \| append \[search `sap_logserv_idx_macro` \.\.\.\]\.$/
                .test(String(r.reason)));
        const named3z = [].concat(guardMod.SUBSEARCH_HOSTS || [], guardMod.START_COMMANDS || [],
            guardMod.ALLOW_LIST_OPERATORS || []);
        p3z('(g) union refused, append suggested', union3z.length === 0 && Array.isArray(guardMod.SUBSEARCH_HOSTS)
            && Array.isArray(guardMod.START_COMMANDS) && named3z.every((c) => !/union/.test(c)),
            'a union (the P2 shapes) must be refused as command_not_allowed naming union, with the append hint, and union'
            + ` may not be a subsearch host, a start command or an operator - wrong on [${union3z.map(([q]) => q.slice(0, 60)).join(' / ')}]`);
        const unionLines3z = hook3z.split('\n').map((l) => l.trim()).filter((l) => /\bunion\b/i.test(l));
        p3z('(g) primers name union only to refuse it', unionLines3z.length === 2
            && unionLines3z.every((l) => l === '`append; union is not on the list (Splunk rewrites a union before ` +'),
            `${unionLines3z.length} line(s) of the hook's code name union - only the two primers' "union is not on the list"`
            + ' lines may (union is off the allow-list)');
        const shadow3z = guardMod.checkParserAgreement(guardMod.analyzeAdHocSpl('`sap_logserv_idx_macro` | stats count'),
            { commands: [{ command: 'search', rawargs: 'sourcetype=x' }, { command: 'stats', rawargs: 'count' }] });
        const nested3z = guardMod.checkParserAgreement(guardMod.analyzeAdHocSpl('`sap_logserv_idx_macro` | stats count'),
            { commands: [{ command: 'search', args: { x: { command: 'outputlookup' } } }, { command: 'stats' }] });
        const none3z = guardMod.checkParserAgreement(guardMod.analyzeAdHocSpl('`sap_logserv_idx_macro` | stats count'), {});
        p3z('(g) parser agreement', shadow3z.operator === 'parser_mismatch' && nested3z.operator === 'parser_mismatch'
            && none3z.operator === 'parser_unavailable',
            `a shadowed macro and a nested command not on the list are parser_mismatch, a reply with no command list`
            + ` parser_unavailable - got ${JSON.stringify([shadow3z.operator, nested3z.operator, none3z.operator])}`);
        // Build 378: the lookup a top-level lookup / inputlookup names is read
        // again from the parser's raw arguments (the shape live probe P2
        // recorded) and must be one of the App's; a shape it cannot read - a
        // quoted or glued name, an option the command does not document, no raw
        // arguments - refuses (parser_mismatch, naming the command).
        const lkLocal3z = guardMod.analyzeAdHocSpl('`sap_logserv_idx_macro` | lookup logserv_ti_malicious_ips ip AS dest OUTPUT category');
        const lkReply3z = (raw) => guardMod.checkParserAgreement(lkLocal3z, { commands: [
            { command: 'search', rawargs: 'index="sap_logserv_logs" ' },
            raw === undefined ? { command: 'lookup' } : { command: 'lookup', rawargs: raw }] });
        const lkOk3z = [lkReply3z('logserv_ti_malicious_ips ip AS dest OUTPUT category AS ti_category, source AS ti_source '),
            lkReply3z('local=t logserv_ti_malicious_ips ip AS dest OUTPUT category')];
        const lkBad3z = [
            'logserv_diag_reports report_id OUTPUT x',
            "event_time_field='x logserv_diag_reports report_id ' logserv_mc_rollup host",
            'event_time_field="x" logserv_ti_malicious_ips ip',
            'logserv_ti_malicious_ips"_x" ip',
            'x=1 logserv_ti_malicious_ips ip',
            undefined,
        ].filter((raw) => {
            const r = lkReply3z(raw);
            return !r || r.blocked !== true || r.operator !== 'parser_mismatch' || r.command !== 'lookup';
        });
        const ilBad3z = guardMod.checkParserAgreement(guardMod.analyzeAdHocSpl('| inputlookup logserv_mc_rollup | stats count'),
            { commands: [{ command: 'inputlookup', rawargs: 'logserv_diag_reports ' }, { command: 'stats', rawargs: 'count' }] });
        // Every top-level lookup / inputlookup is read, not only the first or
        // the last: three in one query, the foreign name in each position
        // (-1: none foreign, the query passes).
        const mlCmds3z = ['inputlookup', 'lookup', 'lookup'];
        const mlRaw3z = ['logserv_mc_rollup ', 'logserv_ti_malicious_ips ip AS host OUTPUT category ',
            'logserv_ti_malicious_domains domain AS host OUTPUT category AS c2'];
        const mlLocal3z = guardMod.analyzeAdHocSpl('| inputlookup logserv_mc_rollup | lookup logserv_ti_malicious_ips ip AS host'
            + ' OUTPUT category | lookup logserv_ti_malicious_domains domain AS host OUTPUT category AS c2');
        const mlBad3z = [-1, 0, 1, 2].filter((bad) => {
            const r = guardMod.checkParserAgreement(mlLocal3z, { commands: mlCmds3z.map((c, i) => (
                { command: c, rawargs: i === bad ? 'logserv_diag_reports x ' : mlRaw3z[i] })) });
            return bad === -1 ? !r || r.blocked !== false
                : !r || r.blocked !== true || r.operator !== 'parser_mismatch' || r.command !== mlCmds3z[bad];
        });
        p3z('(g) parser lookup names', !!lkLocal3z && lkLocal3z.blocked === false
            && lkOk3z.every((r) => !!r && r.blocked === false) && lkBad3z.length === 0
            && !!ilBad3z && ilBad3z.operator === 'parser_mismatch' && ilBad3z.command === 'inputlookup'
            && !!mlLocal3z && mlLocal3z.blocked === false && mlBad3z.length === 0
            && typeof guardMod.parserLookupName === 'function'
            && guardMod.parserLookupName('inputlookup', 'append=t max=10 logserv_topology_edges where type="rfc"') === 'logserv_topology_edges',
            'checkParserAgreement must read the lookup of every top-level lookup / inputlookup again from the parser\'s raw'
            + ' arguments and refuse (parser_mismatch, naming the command) one not in ALLOWED_SPL_LOOKUPS or a shape it cannot'
            + ` read - passed: ${JSON.stringify(lkBad3z)}; of three lookups, wrong at position: ${JSON.stringify(mlBad3z)}`);
    } else {
        p3z('(g) allow-list evaluates', false, 'splGuard / splLexer did not evaluate, or analyzeAdHocSpl is missing');
    }
    // The hook: every ad-hoc query through vetAdHocQuery (the allow-list and
    // Splunk's parser), once, with the user and the turn's signal; the audit
    // event records the command; the denylist is never called on its own.
    const vetLine3z = 'const guard = await vetAdHocQuery(adHocQuery, { user: ctx.user, signal: controller.signal });';
    p3z('(g) the hook vets through the allow-list and the parser', (hook3z.match(/\bvetAdHocQuery\(/g) || []).length === 1
        && hook3z.indexOf(vetLine3z) !== -1 && !/\banalyzeSpl\(|\banalyzeAdHocSpl\(/.test(hook3z)
        && hook3z.indexOf("import { vetAdHocQuery } from '../components/ai/splParserCheck';") !== -1
        && hook3z.indexOf("if (toolName === 'splunk_run_query') {\n                                const adHocQuery = typeof mcpArgs.query === 'string' ? mcpArgs.query : '';\n") !== -1
        && hook3z.indexOf('...(guard.command ? { command: guard.command } : {}),') !== -1,
        `the tool loop must vet splunk_run_query with \`${vetLine3z}\` (once; no bare analyzeSpl) and record guard.command`);
    // The parser check fails closed: any status but 2xx, a body that is not
    // JSON, a thrown or timed-out call, an aborted turn - all refuse.
    const pc3z = fs.existsSync(PC_3Z) ? code3z(read3z(PC_3Z), PC_3Z) : '';
    p3z('(g) parser check fails closed', pc3z.indexOf('    if (status === 400) return parserRejected();\n'
        + '    if (!(status >= 200 && status < 300)) return parserUnavailable();\n') !== -1
        && pc3z.indexOf('    } catch (_e) {\n        return parserUnavailable();\n    }\n    return checkParserAgreement(local, body);\n') !== -1
        && pc3z.indexOf('        if (got === null) return parserUnavailable();\n        return interpretParserReply(local, got.status, got.text);\n'
            + '    } catch (_e) {\n        return parserUnavailable();\n') !== -1
        && pc3z.indexOf('        if (opts.signal.aborted) return parserUnavailable();\n') !== -1
        && pc3z.indexOf("    body.set('parse_only', '1');\n") !== -1,
        'splParserCheck.ts must refuse on 400 (parser_rejected) and on any other non-2xx status, a non-JSON body, a'
        + ' thrown or timed-out call and an aborted turn (parser_unavailable)');
    // (h) build 378: the AI data-model hint names only what the App defines.
    // For its gateway connection-record, HANA audit, HANA trace and SAP Router
    // entries, every snake_case word must be DEFINED by that sourcetype's
    // props.conf stanza - a named group (?<w>) of an EXTRACT, the AS target
    // of a FIELDALIAS, an EVAL-w, or a quoted value an EVAL writes (such as
    // sql_trace); a word that only a comment names, or that an EVAL only
    // reads, defines nothing. For its topology edges entry, every column must
    // be in the collection's fields_list and every edge type a literal
    // type="..." on a setting line of the edges aggregate. Catches a hint that
    // names a field a lane renamed or dropped (build 377's hint named `peer`
    // and `error`, which no stanza defines).
    {
        const dmH3z = (/const LOGSERV_DATA_MODEL = `([\s\S]*?)\n`;\n/.exec(read3z(HOOK_3Z)) || [])[1] || '';
        const propsH3z = read3z(PROPS_CONF);
        const tfH3z = read3z(path.join(path.dirname(SS_3Z), 'transforms.conf'));
        const ssH3z = read3z(SS_3Z);
        const sliceH3z = (text, at, ends) => {
            if (at === -1) return '';
            const stops = ends.map((e) => text.indexOf(e, at + 1)).filter((x) => x !== -1);
            return text.slice(at, stops.length ? Math.min(...stops) : text.length);
        };
        const stanzaH3z = (src, name) => sliceH3z(src, src.indexOf(`\n[${name}]\n`), ['\n[']);
        const settingsH3z = (s) => s.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
        const definesH3z = (lines, w) => lines.some((l) => (/^EXTRACT-/.test(l) && new RegExp(`\\(\\?P?<${w}>`).test(l))
            || new RegExp(`^FIELDALIAS-[^=]*=.*\\b[Aa][Ss](?:[Nn][Ee][Ww])?\\s+"?${w}"?(?:\\s|$)`).test(l)
            || new RegExp(`^EVAL-${w}\\s*=`).test(l)
            || (/^EVAL-/.test(l) && l.indexOf(`"${w}"`) !== -1));
        const blockH3z = (head) => sliceH3z(dmH3z, dmH3z.indexOf(`\n- ${head}`), ['\n- ', '\n\n']);
        const snakeH3z = (s) => Array.from(new Set(s.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []));
        const probH3z = [];
        [['sap:abap:gateway connection records', 'sap:abap:gateway'], ['sap:hana:audit', 'sap:hana:audit'],
            ['sap:hana:tracelogs', 'sap:hana:tracelogs'], ['sap:saprouter', 'sap:saprouter']].forEach(([head, st]) => {
            const b = blockH3z(head);
            const s = stanzaH3z(propsH3z, st);
            if (!b || !s) {
                probH3z.push(`no hint entry or no props.conf stanza for ${st}`);
                return;
            }
            const linesH3z = settingsH3z(s);
            snakeH3z(b).filter((w) => !definesH3z(linesH3z, w)).forEach((w) => probH3z.push(`${st}: ${w}`));
        });
        // Build 379 (session 160, 378 review item 18): the entries that name several sourcetypes - every field word must
        // be defined by at least one of the stanzas the entry covers. The ABAP entry named sap_inst, severity, message
        // and error_code, which no ABAP stanza defines.
        [['sap:abap:workprocess, dispatcher', ['sap:abap:workprocess', 'sap:abap:dispatcher', 'sap:abap:gateway',
            'sap:abap:enqueueserver', 'sap:abap:messageserver', 'sap:abap:audit', 'sap:abap:sapstartsrv', 'sap:abap:event']],
        ['sap:saphostexec, sap:sapstartsrv', ['sap:saphostexec', 'sap:sapstartsrv']]].forEach(([head, sts]) => {
            const b = blockH3z(head);
            const ss = sts.map((st) => stanzaH3z(propsH3z, st));
            if (!b || ss.some((s) => !s)) {
                probH3z.push(`no hint entry or a missing props.conf stanza for ${head}`);
                return;
            }
            const linesAll = ss.map((s) => settingsH3z(s));
            snakeH3z(b).filter((w) => !linesAll.some((ls) => definesH3z(ls, w))).forEach((w) => probH3z.push(`${head}: ${w}`));
        });
        const edgesH3z = blockH3z('| inputlookup logserv_topology_edges');
        const colsH3z = ((/^fields_list\s*=\s*(.*)$/m.exec(stanzaH3z(tfH3z, 'logserv_topology_edges')) || [])[1] || '')
            .split(',').map((x) => x.trim());
        const typesH3z = ((/\btype \(([a-z_|]+)\)/.exec(edgesH3z) || [])[1] || '').split('|').filter(Boolean);
        const aggH3z = settingsH3z(stanzaH3z(ssH3z, 'logserv_topology_aggregate_edges')).join('\n');
        if (!edgesH3z || typesH3z.length < 5 || colsH3z.length < 5) probH3z.push('the topology edges entry or its collection could not be read');
        snakeH3z(edgesH3z).filter((w) => w !== 'logserv_topology_edges' && typesH3z.indexOf(w) === -1 && colsH3z.indexOf(w) === -1)
            .forEach((w) => probH3z.push(`logserv_topology_edges column: ${w}`));
        typesH3z.filter((t) => aggH3z.indexOf(`type="${t}"`) === -1).forEach((t) => probH3z.push(`edge type: ${t}`));
        p3z('(h) the AI data-model hint names real fields', probH3z.length === 0,
            `LOGSERV_DATA_MODEL (hooks/useAIAssistant.ts) names what props.conf / transforms.conf / the edges aggregate`
            + ` do not define: ${probH3z.join(', ')}`);
    }

    // (e) the dispatcher and the tool loop.
    const disp3z = body3z(hook3z, 'const dispatchTool = async (', '\n};\n');
    const fwd3z = disp3z.match(/\.invokeTool\(([^,)]*)/g) || [];
    p3z('(e) only splunk_run_query forwarded', fwd3z.length > 0
        && fwd3z.every((c) => c === ".invokeTool('splunk_run_query'"),
        `dispatchTool passes [${fwd3z.join(', ')}] to invokeTool - only the literal 'splunk_run_query' may go there`);
    p3z('(e) unknown tools refused', /\n {4}return markHidden<MCPToolResult>\(\{\n {8}content: \[\],\n {8}isError: true,\n[^]*?\n {4}\} as MCPToolResult\);\n\};\n$/.test(disp3z),
        'dispatchTool must end by refusing any other tool (an isError result, no MCP call)');
    p3z('(e) saved search through the allow-list', disp3z.indexOf('        return mcpClient.runSavedSearch(name,'
        + ' ALLOWED_SAVED_SEARCHES, pickSavedSearchTimeRange(args));\n') !== -1
        && !/args\.arguments|\.\.\./.test(disp3z),
        'dispatchTool sends a saved search as runSavedSearch(name, ALLOWED_SAVED_SEARCHES, pickSavedSearchTimeRange(args))'
        + ' and forwards no `arguments` object');
    // Every .ts / .tsx under pages/home but MCPClient.ts and the tests (the
    // hook as substituted above), on its syntax tree. invokeTool may be a
    // member or signature NAME (a type, an object key, a method), or the
    // callee - `x.invokeTool(...)` or `invokeTool(...)` - of a call whose
    // first argument is the literal 'splunk_run_query'; anything else (a
    // destructuring, a ternary branch, a shorthand, an alias) is a forward.
    // Outside the hook nothing may name runSavedSearch: a caller elsewhere
    // could pass its own allow-list. The string literals 'invokeTool' and
    // 'runSavedSearch' count as references (an element access); only a
    // literal TYPE is exempt.
    const MEMBER_3Z = [K3z.PropertySignature, K3z.MethodSignature, K3z.PropertyAssignment, K3z.MethodDeclaration,
        K3z.PropertyDeclaration];
    const lit3z = (a, s) => !!a && (a.kind === K3z.StringLiteral || a.kind === K3z.NoSubstitutionTemplateLiteral)
        && a.text === s;
    const fwdOk3z = (id) => {
        const p = id.parent;
        if (MEMBER_3Z.indexOf(p.kind) !== -1 && p.name === id) return true;
        const callee = p.kind === K3z.PropertyAccessExpression && p.name === id ? p : id;
        const call = callee.parent;
        return !!call && call.kind === K3z.CallExpression && call.expression === callee
            && lit3z(call.arguments[0], 'splunk_run_query');
    };
    // Round 4: exempt by path under the walked root - the client itself and
    // the one test that names runSavedSearch - not by name: a file called
    // MCPClient.ts or *.consistency-test.ts anywhere else is walked. .js /
    // .jsx / .mjs / .cjs are walked too (webpack resolves them).
    const FWD_EXEMPT_3Z = ['components/ai/mcp/MCPClient.ts', 'utils/savedSearchAllowList.consistency-test.ts'];
    const fwdBad3z = [];
    const runElse3z = [];
    let walked3z = 0;
    const fwdWalk3z = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const f = path.join(d, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'node_modules') fwdWalk3z(f);
            return;
        }
        if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) return;
        const rel = path.relative(FWD_ROOT_3Z, f).split(path.sep).join('/');
        if (FWD_EXEMPT_3Z.indexOf(rel) !== -1) return;
        const isHook = rel === 'hooks/useAIAssistant.ts';
        const src = read3z(isHook ? HOOK_3Z : f);
        const sf = ast3z(src, f);
        walked3z += 1;
        const at = (n) => `${rel}: ${src.slice(n.getStart(sf), n.getStart(sf) + 60).split('\n')[0]}`;
        eachNode3z(sf, (n) => {
            const isId = n.kind === K3z.Identifier;
            const isStr = (n.kind === K3z.StringLiteral || n.kind === K3z.NoSubstitutionTemplateLiteral)
                && n.parent.kind !== K3z.LiteralType;
            if (!isId && !isStr) return;
            if (n.text === 'invokeTool' && (isStr || !fwdOk3z(n))) fwdBad3z.push(at(n));
            if (n.text === 'runSavedSearch' && !isHook) runElse3z.push(at(n));
        });
    });
    fwdWalk3z(FWD_ROOT_3Z);
    const fwdGone3z = FWD_EXEMPT_3Z.filter((r) => !fs.existsSync(path.join(FWD_ROOT_3Z, r)));
    p3z('(e) no forwarding elsewhere', walked3z > 0 && fwdBad3z.length === 0 && fwdGone3z.length === 0,
        `[${fwdBad3z.join(' / ')}] - outside MCPClient, invokeTool may be called with the literal 'splunk_run_query' only`
        + (fwdGone3z.length ? `; exempt path(s) missing: [${fwdGone3z.join(', ')}]` : ''));
    p3z('(e) no saved-search call elsewhere', walked3z > 0 && runElse3z.length === 0,
        `[${runElse3z.join(' / ')}] - outside MCPClient and the hook nothing may name runSavedSearch;`
        + ' the caller would supply the allow-list it is checked against');
    // Round 3: the name the call sites pass is that binding - the hook
    // declares ALLOWED_SAVED_SEARCHES once, as a module-level const.
    const hookSf3z = ast3z(hook3z, HOOK_3Z);
    const DECL_3Z = [K3z.VariableDeclaration, K3z.Parameter, K3z.BindingElement, K3z.ImportSpecifier,
        K3z.ImportClause, K3z.NamespaceImport, K3z.ImportEqualsDeclaration, K3z.FunctionDeclaration,
        K3z.ClassDeclaration, K3z.EnumDeclaration];
    const allowDecl3z = [];
    eachNode3z(hookSf3z, (n) => {
        if (n.kind === K3z.Identifier && n.text === 'ALLOWED_SAVED_SEARCHES' && DECL_3Z.indexOf(n.parent.kind) !== -1
            && n.parent.name === n) allowDecl3z.push(n.parent);
    });
    const ad3z = allowDecl3z[0];
    p3z('(e) one allow-list binding', allowDecl3z.length === 1 && ad3z.kind === K3z.VariableDeclaration
        && ad3z.parent.kind === K3z.VariableDeclarationList && (ad3z.parent.flags & ts.NodeFlags.Const) !== 0
        && ad3z.parent.parent.kind === K3z.VariableStatement && ad3z.parent.parent.parent.kind === K3z.SourceFile
        && !!ad3z.initializer && ad3z.initializer.kind === K3z.CallExpression
        && ad3z.initializer.expression.getText(hookSf3z) === 'buildAllowedSavedSearches',
        `${allowDecl3z.length} declaration(s) of ALLOWED_SAVED_SEARCHES in the hook - exactly one, the module-level`
        + ' const built by buildAllowedSavedSearches, or a call site can see a shadowing set');
    // Round 4: on the syntax tree (a string or template literal holding the
    // same text proves nothing): one argument, the intent map's prompts, the
    // map the default import of the shipped JSON, the builder the module's.
    const declsOf3z = (sf, name) => {
        const out = [];
        eachNode3z(sf, (n) => {
            if (n.kind === K3z.Identifier && n.text === name && DECL_3Z.indexOf(n.parent.kind) !== -1
                && n.parent.name === n) out.push(n.parent);
        });
        return out;
    };
    const importFrom3z = (d) => {
        let s = d;
        while (s && s.kind !== K3z.ImportDeclaration) s = s.parent;
        return s ? s.moduleSpecifier.text : null;
    };
    const init3z = ad3z && ad3z.initializer && ad3z.initializer.kind === K3z.CallExpression ? ad3z.initializer : null;
    const imDecl3z = declsOf3z(hookSf3z, 'intentMap');
    const babDecl3z = declsOf3z(hookSf3z, 'buildAllowedSavedSearches');
    p3z('(e) allow-list from the intent map', !!init3z
        && init3z.expression.getText(hookSf3z) === 'buildAllowedSavedSearches' && init3z.arguments.length === 1
        && init3z.arguments[0].getText(hookSf3z) === '(intentMap as unknown as IntentMapShape).prompts'
        && imDecl3z.length === 1 && imDecl3z[0].kind === K3z.ImportClause && !imDecl3z[0].namedBindings
        && importFrom3z(imDecl3z[0]) === '../../../../resources/splunk/default/data/mcp/logserv_intent_map.json'
        && babDecl3z.length === 1 && babDecl3z[0].kind === K3z.ImportSpecifier && !babDecl3z[0].propertyName
        && importFrom3z(babDecl3z[0]) === '../utils/savedSearchAllowList',
        'ALLOWED_SAVED_SEARCHES must be buildAllowedSavedSearches((intentMap as unknown as IntentMapShape).prompts),'
        + ' with intentMap the default import of the shipped logserv_intent_map.json and the builder imported from'
        + ' ../utils/savedSearchAllowList - found '
        + (init3z ? `\`${init3z.getText(hookSf3z).replace(/\s+/g, ' ').slice(0, 160)}\`` : 'no call initializer'));
    // Round 4: every other reference is the allow-list argument of a call -
    // argument 2 of x.runSavedSearch(...), argument 3 of vetToolCall(...);
    // a cast, a member access, an assignment or a spread is not.
    const allowRefBad3z = [];
    eachNode3z(hookSf3z, (n) => {
        if (n.kind !== K3z.Identifier || n.text !== 'ALLOWED_SAVED_SEARCHES') return;
        const p = n.parent;
        if (DECL_3Z.indexOf(p.kind) !== -1 && p.name === n) return;
        const i = p.kind === K3z.CallExpression ? p.arguments.indexOf(n) : -1;
        const ok = (i === 1 && p.expression.kind === K3z.PropertyAccessExpression && p.expression.name.text === 'runSavedSearch')
            || (i === 2 && p.expression.kind === K3z.Identifier && p.expression.text === 'vetToolCall');
        if (!ok) allowRefBad3z.push(hook3z.slice(Math.max(0, n.getStart(hookSf3z) - 30), n.getStart(hookSf3z) + 40).replace(/\s+/g, ' '));
    });
    p3z('(e) allow-list references', allowRefBad3z.length === 0,
        `[${allowRefBad3z.join(' / ')}] - ALLOWED_SAVED_SEARCHES may only be passed as the allow-list of`
        + ' x.runSavedSearch(name, ALLOWED_SAVED_SEARCHES, ...) or vetToolCall(name, args, ALLOWED_SAVED_SEARCHES)');
    // Every .runSavedSearch( in the hook's code - as many as the wired test's
    // H10 requires - with ALLOWED_SAVED_SEARCHES as argument 2, found by an
    // index scan over argument 1 (brackets and strings skipped), and no
    // reference that is not a call (an alias) or the dispatcher's type member.
    const h10 = /count\(hookCode, '\.runSavedSearch\('\) === (\d+)/.exec(read3z(TEST_3Z));
    const wantRuns3z = h10 ? Number(h10[1]) : -1;
    const argEnd3z = (s, from) => {
        let depth = 0;
        for (let k = from; k < s.length; k += 1) {
            const c = s[k];
            if (c === "'" || c === '"' || c === '`') {
                for (k += 1; k < s.length && s[k] !== c; k += 1) if (s[k] === '\\') k += 1;
            } else if ('([{'.indexOf(c) !== -1) {
                depth += 1;
            } else if (')]}'.indexOf(c) !== -1) {
                if (depth === 0) return k;
                depth -= 1;
            } else if (c === ',' && depth === 0) {
                return k;
            }
        }
        return -1;
    };
    const RUN_3Z = '.runSavedSearch(';
    const runAt3z = [];
    for (let i = hook3z.indexOf(RUN_3Z); i !== -1; i = hook3z.indexOf(RUN_3Z, i + 1)) runAt3z.push(i);
    const runBad3z = runAt3z.filter((i) => {
        const j = argEnd3z(hook3z, i + RUN_3Z.length);
        return j === -1 || !/^,\s*ALLOWED_SAVED_SEARCHES\s*,/.test(hook3z.slice(j));
    }).map((i) => hook3z.slice(i, i + 90).split('\n')[0]);
    const alias3z = hook3z.match(/\brunSavedSearch\b(?!\s*[(:])/g) || [];
    p3z('(e) every saved-search call passes the allow-list', wantRuns3z > 0 && runAt3z.length === wantRuns3z
        && runBad3z.length === 0 && alias3z.length === 0,
        `${runAt3z.length} .runSavedSearch( call(s) (H10 requires ${wantRuns3z}); without ALLOWED_SAVED_SEARCHES`
        + ` as argument 2: [${runBad3z.join(' / ')}]; ${alias3z.length} uncalled reference(s)`);
    const vet3z = hook3z.indexOf('const toolVerdict = vetToolCall(toolName, parsedArgs, ALLOWED_SAVED_SEARCHES);');
    const go3z = hook3z.indexOf('await dispatchTool(ctx.mcpClient, toolName, mcpArgs)');
    const pre3z = vet3z !== -1 && go3z > vet3z ? hook3z.slice(vet3z, go3z) : '';
    // The refusal block: from its opener to the `return;` that ends it, at
    // the block's own indentation.
    const ind3z = /\n([ \t]*)if \(!toolVerdict\.ok\) \{\n/.exec(pre3z);
    // Round 3: every dispatchTool reference on the code-only hook's syntax
    // tree - one declaration and ONE call, the anchored one above, which
    // follows the refusal block; any other call (unawaited, `void`) or
    // reference (an alias) fails.
    const dispCall3z = [];
    const dispOther3z = [];
    let dispDecl3z = 0;
    eachNode3z(hookSf3z, (n) => {
        if (n.kind !== K3z.Identifier || n.text !== 'dispatchTool') return;
        const p = n.parent;
        if (p.kind === K3z.VariableDeclaration && p.name === n) dispDecl3z += 1;
        else if (p.kind === K3z.CallExpression && p.expression === n) dispCall3z.push(n.getStart(hookSf3z));
        else dispOther3z.push(hook3z.slice(n.getStart(hookSf3z), n.getStart(hookSf3z) + 50).split('\n')[0]);
    });
    const dispOk3z = dispDecl3z === 1 && dispCall3z.length === 1 && dispOther3z.length === 0
        && go3z !== -1 && dispCall3z[0] === go3z + 'await '.length;
    const blk3z = ind3z ? body3z(pre3z, 'if (!toolVerdict.ok) {\n', `\n${ind3z[1]}    return;\n${ind3z[1]}}\n`) : '';
    p3z('(e) refused before dispatch', blk3z.length > 0 && dispOk3z
        && blk3z.indexOf("category: 'security_blocked_spl',") !== -1
        && blk3z.indexOf('operator: toolVerdict.operator,') !== -1
        && blk3z.indexOf('ctx.actions.recordAudit(refusedAudit);') !== -1,
        'the tool loop must run vetToolCall and, on a refusal, record the security_blocked_spl event and return'
        + ` before its one dispatchTool call - found ${dispCall3z.length} call(s), ${dispOther3z.length} other`
        + ` reference(s) [${dispOther3z.join(' / ')}], ${dispDecl3z} declaration(s)`);

    // (f) round 4: what a tool result tells the AI vendor. Code-only hook,
    // on its syntax tree.
    const norm3z = (s) => s.replace(/\s+/g, ' ').replace(/,\s*\)/g, ')').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    const callsOf3z = (root, name) => {
        const out = [];
        eachNode3z(root, (n) => {
            if (n.kind === K3z.CallExpression && n.expression.kind === K3z.Identifier && n.expression.text === name) out.push(n);
        });
        return out;
    };
    const idsOf3z = (root, name) => {
        let k = 0;
        eachNode3z(root, (n) => {
            if (n.kind === K3z.Identifier && n.text === name) k += 1;
        });
        return k;
    };
    const IMPORT_F_3Z = "import { vendorRefusalText, vendorToolErrorText } from '../utils/vendorErrorText';";
    const vrtDecl3z = declsOf3z(hookSf3z, 'vendorRefusalText');
    const vteDecl3z = declsOf3z(hookSf3z, 'vendorToolErrorText');
    p3z('(f) vendor text module', hook3z.split('\n').indexOf(IMPORT_F_3Z) !== -1
        && vrtDecl3z.length === 1 && vrtDecl3z[0].kind === K3z.ImportSpecifier
        && vteDecl3z.length === 1 && vteDecl3z[0].kind === K3z.ImportSpecifier,
        `the hook must import { vendorRefusalText, vendorToolErrorText } from '../utils/vendorErrorText' and declare`
        + ' neither name itself');
    // Each summary: one `const detected = detectToolError(inner);`, then
    // `if (detected) { return wrapAsToolResultData(vendorToolErrorText(detected)); }`,
    // and no read of a message, an errorMessage or a refusal text anywhere in it.
    // Round 5 (round-4 finding 2): the statement LIST, not just the pair -
    // tier1Summary is exactly its six statements (round 7, round-6 finding 8:
    // it counts the rows extractRowsForSummary recognises - 0 for an empty
    // result - and countRows(inner.content) only when none is recognised, as
    // tier2Summary counts them), tier2Summary starts with
    // the pair (statements 0 and 1; the rest is '(f) tier2Summary columns'),
    // and in either one `inner` is read only as detectToolError(inner),
    // extractRowsForSummary(inner), countRows(inner.content) and
    // inner.executionMs: an isError branch before the pair, a content[...]
    // read or a JSON.stringify(inner.content) in a return is none of them.
    const DET_3Z = 'const detected = detectToolError(inner);';
    const IF_DET_3Z = 'if (detected) { return wrapAsToolResultData(vendorToolErrorText(detected)); }';
    const T1_STMTS_3Z = [DET_3Z, IF_DET_3Z, 'const found = extractRowsForSummary(inner);',
        'const rowCount = found === null ? countRows(inner.content) : found.length;',
        'const ms = inner.executionMs ?? fallbackMs;',
        'return wrapAsToolResultData(`Returned $' + '{rowCount} rows in $' + '{ms}ms.`);'];
    const summaryFn3z = (name) => {
        const d = declsOf3z(hookSf3z, name);
        return d.length === 1 && d[0].kind === K3z.VariableDeclaration && d[0].initializer
            && d[0].initializer.kind === K3z.ArrowFunction && d[0].initializer.body.kind === K3z.Block
            && d[0].parent.parent.parent.kind === K3z.SourceFile ? d[0].initializer : null;
    };
    const isCall3z = (c, callee) => !!c && c.kind === K3z.CallExpression && c.expression.kind === K3z.Identifier
        && c.expression.text === callee && c.arguments.length === 1;
    const innerReads3z = (fn) => {
        const bad = [];
        eachNode3z(fn.body, (n) => {
            if (n.kind !== K3z.Identifier || n.text !== 'inner') return;
            const p = n.parent;
            if ((isCall3z(p, 'detectToolError') || isCall3z(p, 'extractRowsForSummary')) && p.arguments[0] === n) return;
            if (p.kind === K3z.PropertyAccessExpression && p.expression === n && !p.questionDotToken) {
                if (p.name.text === 'executionMs') return;
                if (p.name.text === 'content' && isCall3z(p.parent, 'countRows') && p.parent.arguments[0] === p) return;
            }
            const ctx = p.kind === K3z.PropertyAccessExpression || p.kind === K3z.ElementAccessExpression ? p.parent : p;
            bad.push(norm3z(ctx.getText(hookSf3z)).slice(0, 80));
        });
        return bad;
    };
    ['tier1Summary', 'tier2Summary'].forEach((name) => {
        const fn = summaryFn3z(name);
        const why = [];
        if (!fn) {
            why.push('not one module-level const arrow function with a block body');
        } else {
            const st = fn.body.statements.map((s) => norm3z(s.getText(hookSf3z)));
            if (name === 'tier1Summary') {
                if (JSON.stringify(st) !== JSON.stringify(T1_STMTS_3Z)) {
                    why.push(`its ${st.length} statement(s) are not exactly [${T1_STMTS_3Z.join(' ')}]`);
                }
            } else if (st[0] !== DET_3Z || st[1] !== IF_DET_3Z) {
                why.push(`its first two statements are not exactly \`${DET_3Z}\` and \`${IF_DET_3Z}\``);
            }
            const dets = st.filter((s) => s === DET_3Z).length;
            if (dets !== 1) why.push(`${dets} \`${DET_3Z}\``);
            const innerBad = innerReads3z(fn);
            if (innerBad.length) {
                why.push(`reads inner as [${innerBad.join(' / ')}] - only detectToolError(inner), extractRowsForSummary(inner),`
                    + ' countRows(inner.content) and inner.executionMs');
            }
            const reads = [];
            eachNode3z(fn, (n) => {
                if (n.kind === K3z.PropertyAccessExpression && /^(message|errorMessage)$/.test(n.name.text)) reads.push(n.getText(hookSf3z));
                if (n.kind === K3z.ElementAccessExpression && ((n.argumentExpression
                    && /^(message|errorMessage)$/.test(n.argumentExpression.text || ''))
                    || (n.expression.kind === K3z.Identifier && n.expression.text === 'detected'))) reads.push(n.getText(hookSf3z));
                if (n.kind === K3z.Identifier && /^(vendorRefusalText|sanitizeErrorMessage)$/.test(n.text)) reads.push(n.text);
            });
            const detRefs = idsOf3z(fn, 'detected');
            if (reads.length) why.push(`reads [${reads.join(', ')}]`);
            if (detRefs !== 3) why.push(`names detected ${detRefs} times (the declaration, the test, the argument)`);
        }
        p3z(`(f) ${name} error text`, why.length === 0,
            `${why.join('; ')} - a failed call reaches the vendor only as vendorToolErrorText's status and class`);
    });
    // The one read of detected.message: the dispatcher's local retry test.
    const detMsg3z = [];
    eachNode3z(hookSf3z, (n) => {
        if ((n.kind === K3z.PropertyAccessExpression && n.name.text === 'message'
            && n.expression.kind === K3z.Identifier && n.expression.text === 'detected')
            || (n.kind === K3z.ElementAccessExpression && n.expression.kind === K3z.Identifier
                && n.expression.text === 'detected')) detMsg3z.push(n);
    });
    const inDisp3z = (n) => {
        let s = n;
        while (s && !(s.kind === K3z.VariableDeclaration && s.name.kind === K3z.Identifier && s.name.text === 'dispatchTool')) s = s.parent;
        return !!s;
    };
    let mBad3z = -1;
    if (detMsg3z.length === 1) {
        let stmt = detMsg3z[0];
        while (stmt && stmt.kind !== K3z.VariableStatement) stmt = stmt.parent;
        const blk = stmt ? stmt.parent : null;
        if (stmt && norm3z(stmt.getText(hookSf3z)) === 'const m = detected.message.toLowerCase();' && inDisp3z(stmt) && blk) {
            mBad3z = 0;
            eachNode3z(blk, (n) => {
                if (n.kind !== K3z.Identifier || n.text !== 'm') return;
                const p = n.parent;
                if (p.kind === K3z.VariableDeclaration && p.name === n) return;
                const ok = p.kind === K3z.CallExpression && p.arguments.length === 1 && p.arguments[0] === n
                    && p.expression.kind === K3z.PropertyAccessExpression && p.expression.name.text === 'test';
                if (!ok) mBad3z += 1;
            });
        }
    }
    p3z('(f) one error-text read', detMsg3z.length === 1 && mBad3z === 0,
        `${detMsg3z.length} read(s) of detected.message / detected[...] - exactly one, \`const m = detected.message.toLowerCase();\``
        + ` in dispatchTool, with m used only as regex.test(m) (${mBad3z < 0 ? 'not that statement' : `${mBad3z} other use(s)`})`);
    // No error text read anywhere else in the hook.
    const errReads3z = [];
    eachNode3z(hookSf3z, (n) => {
        if (n.kind === K3z.PropertyAccessExpression && n.name.text === 'errorMessage') errReads3z.push(n.getText(hookSf3z));
        if (n.kind === K3z.ElementAccessExpression && n.argumentExpression
            && /^(errorMessage|message)$/.test(n.argumentExpression.text || '')) errReads3z.push(n.getText(hookSf3z));
        if (n.kind === K3z.Identifier && n.text === 'sanitizeErrorMessage') errReads3z.push(n.text);
    });
    p3z('(f) no error text read', errReads3z.length === 0,
        `[${errReads3z.join(', ')}] - the hook reads no errorMessage and has no sanitizeErrorMessage`);
    // The real result reaches the vendor through the two summaries only.
    // Round 7: tier2Summary's last argument is authorTexts ('(f) authorTexts
    // statement').
    const SAN_REAL_3Z = 'sanitize(toolResult, (r) => tier === 2 ? tier2Summary(r, elapsed, topN, piiOpts, onTier2Redaction,'
        + ' authorTexts) : tier1Summary(r, elapsed))';
    const sanCalls3z = callsOf3z(hookSf3z, 'sanitize');
    const sanReal3z = sanCalls3z.filter((c) => norm3z(c.getText(hookSf3z)) === SAN_REAL_3Z);
    const t1c3z = callsOf3z(hookSf3z, 'tier1Summary');
    const t2c3z = callsOf3z(hookSf3z, 'tier2Summary');
    const inReal3z = (c) => sanReal3z.length === 1 && c.pos >= sanReal3z[0].pos && c.end <= sanReal3z[0].end;
    const nIdx3z = hook3z.split('indexedResults[idx] = {').length - 1;
    p3z('(f) summary paths', callsOf3z(hookSf3z, 'detectToolError').length === 3 && sanCalls3z.length === 4
        && sanReal3z.length === 1 && t1c3z.length === 1 && t2c3z.length === 1 && inReal3z(t1c3z[0]) && inReal3z(t2c3z[0])
        && idsOf3z(hookSf3z, 'tier1Summary') === 2 && idsOf3z(hookSf3z, 'tier2Summary') === 2 && nIdx3z === 4,
        `expected detectToolError( x3, sanitize( x4 (the three refusals and \`${SAN_REAL_3Z}\`), tier1Summary and`
        + ` tier2Summary called once each inside it and named nowhere else, indexedResults[idx] = { x4 - found`
        + ` ${callsOf3z(hookSf3z, 'detectToolError').length}, ${sanCalls3z.length}, ${t1c3z.length}, ${t2c3z.length}, ${nIdx3z}`);
    // Round 7 (the product owner's naming rule; round-6 findings 0 and 4): a
    // Tier 2 column name is sent only when Splunk generates it or every word
    // of it is AUTHOR TEXT - text the model or the App wrote, which tells the
    // vendor nothing new: the model's own query for splunk_run_query, the
    // catalog SPL of the saved search that ran, and all catalog SPL for any
    // other call. authorTexts is declared once, exactly, in the statement
    // right before the real summary's sanitize(); outside tier2Summary it is
    // named only there and as tier2Summary's last argument, and inside, the
    // pinned parameter list and tail allow one use, buildAuthorContext(
    // authorTexts) ('(f) tier2Summary columns'). The catalog text is the
    // shipped SPL ('(f) catalog SPL bindings', '(f) catalog SPL shipped').
    const AUTHOR_3Z = "const authorTexts: ReadonlyArray<string> = toolName === 'splunk_run_query'"
        + " ? (typeof mcpArgs.query === 'string' ? [mcpArgs.query] : [])"
        + ' : savedSearchName && Object.prototype.hasOwnProperty.call(SAVED_SEARCH_SPL, savedSearchName)'
        + ' ? [SAVED_SEARCH_SPL[savedSearchName]] : CATALOG_SPLS;';
    const t2fnAt3z = summaryFn3z('tier2Summary');
    const inT2At3z = (n) => !!t2fnAt3z && n.pos >= t2fnAt3z.pos && n.end <= t2fnAt3z.end;
    const atDecls3z = declsOf3z(hookSf3z, 'authorTexts');
    const atVar3z = atDecls3z.filter((d) => d.kind === K3z.VariableDeclaration);
    const atPar3z = atDecls3z.filter((d) => d.kind === K3z.Parameter && d.parent === t2fnAt3z);
    const atStmt3z = atVar3z.length === 1 && atVar3z[0].parent.parent.kind === K3z.VariableStatement
        ? atVar3z[0].parent.parent : null;
    const atList3z = atStmt3z && atStmt3z.parent && atStmt3z.parent.statements ? atStmt3z.parent.statements : null;
    const atNext3z = atList3z ? atList3z[atList3z.indexOf(atStmt3z) + 1] : null;
    let atOut3z = 0;
    eachNode3z(hookSf3z, (n) => {
        if (n.kind === K3z.Identifier && n.text === 'authorTexts' && !inT2At3z(n)) atOut3z += 1;
    });
    p3z('(f) authorTexts statement', !!atStmt3z && norm3z(atStmt3z.getText(hookSf3z)) === AUTHOR_3Z
        && !!atNext3z && norm3z(atNext3z.getText(hookSf3z)) === `const summary = ${SAN_REAL_3Z};`
        && atDecls3z.length === 2 && atPar3z.length === 1 && atOut3z === 2,
        `authorTexts must be declared once as \`${AUTHOR_3Z}\`, in the statement right before \`const summary =`
        + ` ${SAN_REAL_3Z};\`, and outside tier2Summary (whose last parameter it is) named only there and as`
        + ` tier2Summary's last argument - found ${atDecls3z.length} declaration(s) (${atVar3z.length} variable,`
        + ` ${atPar3z.length} tier2Summary parameter), ${atOut3z} reference(s) outside tier2Summary,`
        + ` ${atStmt3z ? 'that statement' : 'no such statement'}`
        + `${atNext3z ? ` then \`${norm3z(atNext3z.getText(hookSf3z)).slice(0, 80)}\`` : ''}`);
    // The three App refusals: built at the refusal site from the reason the
    // App just wrote into the synthetic result, then the block returns.
    const REASONS_3Z = ['capReason', 'toolVerdict.reason', 'guardReason'];
    const vrtCalls3z = callsOf3z(hookSf3z, 'vendorRefusalText');
    const refBad3z = [];
    if (vrtCalls3z.length !== 3 || idsOf3z(hookSf3z, 'vendorRefusalText') !== 4) {
        refBad3z.push(`${vrtCalls3z.length} call(s), ${idsOf3z(hookSf3z, 'vendorRefusalText')} reference(s)`);
    }
    vrtCalls3z.forEach((c, i) => {
        const x = REASONS_3Z[i];
        let stmt = c;
        while (stmt && stmt.kind !== K3z.VariableStatement) stmt = stmt.parent;
        const blk = stmt ? stmt.parent : null;
        const at = blk && blk.statements ? blk.statements.indexOf(stmt) : -1;
        const before = at > 0 ? blk.statements.slice(0, at) : [];
        const after = at !== -1 ? blk.statements.slice(at + 1) : [];
        let set = false;
        before.forEach((s) => eachNode3z(s, (n) => {
            if (n.kind === K3z.PropertyAssignment && n.name.getText(hookSf3z) === 'errorMessage'
                && n.initializer.getText(hookSf3z) === x) set = true;
        }));
        const ok = !!stmt && norm3z(stmt.getText(hookSf3z))
                === `const summary = sanitize(syntheticHidden, () => wrapAsToolResultData(vendorRefusalText(${x})));`
            && set && after.some((s) => s.kind === K3z.ReturnStatement && !s.expression)
            && !!blk && blk.parent && blk.parent.kind === K3z.IfStatement;
        if (!ok) refBad3z.push(`refusal ${i + 1} (${x})`);
    });
    const codeLines3z = hook3z.split('\n').map((l) => l.trim());
    const CAP_3Z = 'const capReason = `Session tool-call cap reached (${toolCallsPerSessionCap}). Clear chat to start a new'
        + ' session, or ask your admin to raise the cap.`;';
    const GREASON_3Z = "const guardReason = guard.reason ?? 'SPL blocked by static-analysis guard.';";
    if (codeLines3z.indexOf(CAP_3Z) === -1) refBad3z.push('capReason text');
    if (codeLines3z.indexOf(GREASON_3Z) === -1) refBad3z.push('guardReason text');
    p3z('(f) refusals at their sites', refBad3z.length === 0,
        `[${refBad3z.join(', ')}] - each App refusal sends exactly vendorRefusalText(capReason / toolVerdict.reason /`
        + ' guardReason), built in its refusal block after `errorMessage: <the same reason>,` and before its `return;`');
    // Everything else made vendor-visible: literals, or the known values.
    const MV_OK_3Z = ['trimmed', 'turnResult.assistantText', 'toolUseId', 'id', "blk?.toolName ?? ''", 'argsStr',
        'unwrapVisible(basePrimer.content) + POWER_MODE_RULE_SUFFIX'];
    const LIT_3Z = [K3z.StringLiteral, K3z.NoSubstitutionTemplateLiteral, K3z.NumericLiteral, K3z.TrueKeyword,
        K3z.FalseKeyword];
    const pureLit3z = (n) => {
        if (LIT_3Z.indexOf(n.kind) !== -1) return true;
        if (n.kind === K3z.BinaryExpression) return n.operatorToken.kind === K3z.PlusToken && pureLit3z(n.left) && pureLit3z(n.right);
        if (n.kind === K3z.ParenthesizedExpression) return pureLit3z(n.expression);
        if (n.kind === K3z.ArrayLiteralExpression) return n.elements.every(pureLit3z);
        if (n.kind === K3z.ObjectLiteralExpression) {
            return n.properties.every((p) => p.kind === K3z.PropertyAssignment && p.name.kind !== K3z.ComputedPropertyName
                && pureLit3z(p.initializer));
        }
        return false;
    };
    const mvCalls3z = callsOf3z(hookSf3z, 'markVisible');
    const mvBad3z = mvCalls3z.filter((c) => c.arguments.length !== 1
        || (!pureLit3z(c.arguments[0]) && MV_OK_3Z.indexOf(norm3z(c.arguments[0].getText(hookSf3z))) === -1))
        .map((c) => norm3z(c.getText(hookSf3z)).slice(0, 90));
    p3z('(f) vendor-visible values', mvCalls3z.length > 0 && mvBad3z.length === 0,
        `[${mvBad3z.join(' / ')}] - markVisible may wrap a literal, or one of ${MV_OK_3Z.join(', ')}`);
    // Round 5 (round-4 finding 3): the pins above see a call only when its
    // callee is the bare name. So the constructors are imported once,
    // un-renamed, and nothing reaches '../components/ai' whole; each is named
    // only where it is declared and where it is called; the markVisible call
    // count is pinned (a value un-wrapped into a cast lowers it); and no cast
    // names a vendor-visible type.
    const VV_3Z = ['markVisible', 'unwrapVisible', 'sanitize', 'wrapAsToolResultData'];
    const AI_MOD_3Z = /^\.\.\/components\/ai(\/|$)/;
    const vvImpBad3z = [];
    VV_3Z.slice(0, 3).forEach((nm) => {
        const d = declsOf3z(hookSf3z, nm);
        if (!(d.length === 1 && d[0].kind === K3z.ImportSpecifier && !d[0].propertyName
            && importFrom3z(d[0]) === '../components/ai')) {
            vvImpBad3z.push(`${nm}: ${d.length} declaration(s), not one un-renamed import from '../components/ai'`);
        }
    });
    const wtd3z = declsOf3z(hookSf3z, 'wrapAsToolResultData');
    if (!(wtd3z.length === 1 && wtd3z[0].kind === K3z.VariableDeclaration
        && wtd3z[0].parent.kind === K3z.VariableDeclarationList && (wtd3z[0].parent.flags & ts.NodeFlags.Const) !== 0
        && wtd3z[0].parent.parent.parent.kind === K3z.SourceFile)) {
        vvImpBad3z.push(`wrapAsToolResultData: ${wtd3z.length} declaration(s), not one module-level const`);
    }
    eachNode3z(hookSf3z, (n) => {
        if (n.kind === K3z.ImportSpecifier && n.propertyName && VV_3Z.indexOf(n.propertyName.text) !== -1) {
            vvImpBad3z.push(`${n.propertyName.text} imported as ${n.name.text}`);
        }
        const from = n.kind === K3z.NamespaceImport || n.kind === K3z.ImportClause ? importFrom3z(n) || '' : '';
        if (n.kind === K3z.NamespaceImport && AI_MOD_3Z.test(from)) vvImpBad3z.push(`import * as ${n.name.text} from '${from}'`);
        if (n.kind === K3z.ImportClause && n.name && AI_MOD_3Z.test(from)) vvImpBad3z.push(`default import ${n.name.text} from '${from}'`);
        if (n.kind === K3z.ImportEqualsDeclaration) vvImpBad3z.push(`import ${n.name.text} = ...`);
        if (n.kind === K3z.CallExpression && (n.expression.kind === K3z.ImportKeyword
            || (n.expression.kind === K3z.Identifier && n.expression.text === 'require'))) {
            vvImpBad3z.push(norm3z(n.getText(hookSf3z)).slice(0, 60));
        }
    });
    p3z('(f) vendor-visible imports', vvImpBad3z.length === 0,
        `[${vvImpBad3z.join(' / ')}] - markVisible, unwrapVisible and sanitize are imported once, un-renamed, from`
        + " '../components/ai', wrapAsToolResultData is the hook's own module-level const, and the hook imports no"
        + " module under '../components/ai' whole (namespace or default), through import = or require(), or by import()");
    const vvRefBad3z = VV_3Z.filter((nm) => idsOf3z(hookSf3z, nm) !== callsOf3z(hookSf3z, nm).length + 1)
        .map((nm) => `${nm}: ${idsOf3z(hookSf3z, nm)} reference(s), ${callsOf3z(hookSf3z, nm).length} call(s)`);
    p3z('(f) vendor-visible references', vvRefBad3z.length === 0,
        `[${vvRefBad3z.join(' / ')}] - each is named once where it is declared and otherwise only as the callee of a`
        + ' call: an alias, a member access or a typeof hides a call from every pin above');
    const MV_CALLS_3Z = 16;
    p3z('(f) markVisible calls', mvCalls3z.length === MV_CALLS_3Z,
        `${mvCalls3z.length} markVisible(...) calls - exactly ${MV_CALLS_3Z}: a vendor-visible value that is no longer`
        + ' wrapped (replaced by a cast, or reached another way) lowers the count; when a call is added or removed on'
        + ' purpose, review the value and update MV_CALLS_3Z');
    const CAST_3Z = /Visible|sanitize|ToolCallReference|ToolResultReference|\bMessage\b|(?:user|assistant|system|toolResult)Message/;
    const castBad3z = [];
    eachNode3z(hookSf3z, (n) => {
        if ((n.kind === K3z.AsExpression || n.kind === K3z.TypeAssertionExpression || n.kind === K3z.SatisfiesExpression)
            && n.type && CAST_3Z.test(n.type.getText(hookSf3z))) castBad3z.push(norm3z(n.getText(hookSf3z)).slice(0, 90));
    });
    p3z('(f) no Visible casts', castBad3z.length === 0,
        `[${castBad3z.join(' / ')}] - no cast or satisfies may name a Visible type, a vendor message type or the`
        + ' constructors: a vendor-visible value is made by markVisible or sanitize only');
    // Round 5 (round-4 findings 0 and 8): after its error branch, tier2Summary
    // is exactly these statements - every column name, the _time range and
    // every aggregate reach the vendor through vendorColumnLines
    // (utils/vendorColumnText.ts, whose rules vendorColumnText.consistency-test
    // proves); tier2Summary reads no column name, no _time and no value
    // itself. The two util functions are imported un-renamed from that module
    // and called once each, inside tier2Summary; sanitizeAggregateValue is
    // only passed, never called or named elsewhere.
    // Round 7 (round-6 findings 2, 8 and 11; the product owner's naming rule):
    // a reply with no row shape is sent only as "not in row form", with no
    // count and no column (an MCP content block is never a row - '(f) content
    // blocks'); an empty result is "Returned 0 rows"; otherwise the row count
    // and vendorColumnLines over the recognised rows, with the call's author
    // text reaching it only as buildAuthorContext(authorTexts) - the parameter
    // list is pinned, so authorTexts is used nowhere else in tier2Summary.
    const T2_PARAMS_3Z = ['inner: MCPToolResult', 'fallbackMs: number', 'topN: number',
        'piiOpts: PiiRedactionOptions = {}', 'onRedaction?: () => void', 'authorTexts: ReadonlyArray<string> = []'];
    const T2_TAIL_3Z = [
        'const found = extractRowsForSummary(inner);',
        'const ms = inner.executionMs ?? fallbackMs;',
        'if (found === null) { return wrapAsToolResultData(`Returned a result that is not in row form, in $' + '{ms}ms.`); }',
        'if (found.length === 0) { return wrapAsToolResultData(`Returned 0 rows in $' + '{ms}ms (no events matched the'
            + ' query in the selected time range).`); }',
        'const lines: string[] = [`Returned $' + '{found.length} rows in $' + '{ms}ms.`];',
        'lines.push(...vendorColumnLines(found, { topN, sanitizeValue: sanitizeAggregateValue, piiOpts, onRedaction,'
            + ' author: buildAuthorContext(authorTexts), }));',
        "return wrapAsToolResultData(lines.join('\\n'));",
    ];
    const IMPORT_COL_3Z = "import { buildAuthorContext, vendorColumnLines } from '../utils/vendorColumnText';";
    const t2fn3z = summaryFn3z('tier2Summary');
    const colBad3z = [];
    if (!t2fn3z) {
        colBad3z.push('no tier2Summary');
    } else {
        const ss = t2fn3z.body.statements;
        const at = ss.findIndex((s) => s.kind === K3z.IfStatement && s.expression.getText(hookSf3z) === 'detected');
        const tail = at === -1 ? null : ss.slice(at + 1).map((s) => norm3z(s.getText(hookSf3z)));
        if (!tail || JSON.stringify(tail) !== JSON.stringify(T2_TAIL_3Z)) {
            colBad3z.push(`after its error branch, tier2Summary is not exactly the ${T2_TAIL_3Z.length} pinned statements`
                + (tail ? ` (found ${tail.length})` : ' (no `if (detected)` branch)'));
        }
        const params = t2fn3z.parameters.map((p) => norm3z(p.getText(hookSf3z)));
        if (JSON.stringify(params) !== JSON.stringify(T2_PARAMS_3Z)) {
            colBad3z.push(`tier2Summary's parameters are (${params.join(', ')}), not exactly (${T2_PARAMS_3Z.join(', ')})`);
        }
    }
    if (hook3z.split('\n').indexOf(IMPORT_COL_3Z) === -1) colBad3z.push(`no line \`${IMPORT_COL_3Z}\``);
    ['vendorColumnLines', 'buildAuthorContext'].forEach((nm) => {
        const d = declsOf3z(hookSf3z, nm);
        const c = callsOf3z(hookSf3z, nm);
        const inT2 = !!t2fn3z && c.length === 1 && c[0].pos >= t2fn3z.pos && c[0].end <= t2fn3z.end;
        if (!(d.length === 1 && d[0].kind === K3z.ImportSpecifier && !d[0].propertyName
            && importFrom3z(d[0]) === '../utils/vendorColumnText' && idsOf3z(hookSf3z, nm) === 2 && inT2)) {
            colBad3z.push(`${nm}: ${d.length} declaration(s), ${idsOf3z(hookSf3z, nm)} reference(s), ${c.length} call(s)`
                + ' - one un-renamed import from ../utils/vendorColumnText and one call, in tier2Summary');
        }
    });
    if (idsOf3z(hookSf3z, 'sanitizeAggregateValue') !== 2) {
        colBad3z.push(`sanitizeAggregateValue named ${idsOf3z(hookSf3z, 'sanitizeAggregateValue')} times (its declaration`
            + ' and the sanitizeValue argument)');
    }
    p3z('(f) tier2Summary columns', colBad3z.length === 0,
        `[${colBad3z.join(' / ')}] - a Tier 2 column name, the _time range and the aggregates reach the vendor only`
        + ' through vendorColumnLines');
    // Round 7 (round-6 findings 2 and 11): an MCP content block ({type: 'text',
    // text: ...} and the like) is reply text, never a row. extractRowsForSummary
    // returns null for a content array that holds one - after the JSON-rows
    // parse of content[0].text, right before it would take the array as rows -
    // and the two module-level consts that define a block are pinned exactly,
    // each named only where it is declared and where it is used.
    const MCB_TYPES_3Z = "const MCP_CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'audio', 'resource',"
        + " 'resource_link']);";
    const MCB_FN_3Z = "const isMcpContentBlock = (r: unknown): boolean => { if (typeof r !== 'object' || r === null) return"
        + " false; const b = r as Record<string, unknown>; return typeof b.type === 'string' &&"
        + " MCP_CONTENT_BLOCK_TYPES.has(b.type) && ('text' in b || 'data' in b || 'resource' in b || 'uri' in b); };";
    const MCB_TAIL_3Z = ['if (inner.content.some(isMcpContentBlock)) return null;',
        "return inner.content.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);"];
    const modStmt3z = (name) => {
        const d = declsOf3z(hookSf3z, name);
        return d.length === 1 && d[0].kind === K3z.VariableDeclaration && d[0].parent.kind === K3z.VariableDeclarationList
            && (d[0].parent.flags & ts.NodeFlags.Const) !== 0 && d[0].parent.parent.kind === K3z.VariableStatement
            && d[0].parent.parent.parent.kind === K3z.SourceFile ? d[0].parent.parent : null;
    };
    const mcbBad3z = [];
    [['MCP_CONTENT_BLOCK_TYPES', MCB_TYPES_3Z], ['isMcpContentBlock', MCB_FN_3Z]].forEach(([nm, want]) => {
        const st = modStmt3z(nm);
        if (!st || norm3z(st.getText(hookSf3z)) !== want) mcbBad3z.push(`${nm} is not one module-level const \`${want}\``);
        if (idsOf3z(hookSf3z, nm) !== 2) mcbBad3z.push(`${nm} named ${idsOf3z(hookSf3z, nm)} times (its declaration and one use)`);
    });
    const erfs3z = summaryFn3z('extractRowsForSummary');
    const arrIf3z = erfs3z ? erfs3z.body.statements.filter((s) => s.kind === K3z.IfStatement
        && norm3z(s.expression.getText(hookSf3z)) === 'Array.isArray(inner.content)') : [];
    const arrTail3z = arrIf3z.length === 1 && arrIf3z[0].thenStatement.kind === K3z.Block
        ? arrIf3z[0].thenStatement.statements.slice(-2).map((s) => norm3z(s.getText(hookSf3z))) : null;
    if (!arrTail3z || JSON.stringify(arrTail3z) !== JSON.stringify(MCB_TAIL_3Z)) {
        mcbBad3z.push(`extractRowsForSummary's one \`if (Array.isArray(inner.content))\` block does not end with`
            + ` [${MCB_TAIL_3Z.join(' ')}]`);
    }
    p3z('(f) content blocks', mcbBad3z.length === 0,
        `[${mcbBad3z.join(' / ')}] - an MCP content block is reply text: never summarized as a row or a column`);
    // Round 7: the catalog's author text is the shipped SPL only. CATALOG_SPLS
    // and SAVED_SEARCH_SPL are module-level consts built from the spl field of
    // the intent map the hook imports (the import is pinned in '(e) allow-list
    // from the intent map'); CATALOG_SPLS is named only where it is declared
    // and in the authorTexts statement, and SAVED_SEARCH_SPL is only ever read
    // - an element read, or the object of Object.prototype.hasOwnProperty.call
    // - never written, deleted, iterated, passed on or spread. And every
    // intent-map spl is the shipped savedsearches.conf search line of its
    // stanza ('(f) catalog SPL shipped'; check:intent-map proves it too).
    const CAT_3Z = 'const CATALOG_SPLS: ReadonlyArray<string> = (intentMap as unknown as IntentMapShape).prompts.map((p) =>'
        + ' p.spl);';
    const SSS_3Z = 'const SAVED_SEARCH_SPL: Record<string, string> = (() => { const map = intentMap as unknown as'
        + ' IntentMapShape; const out: Record<string, string> = {}; for (const p of map.prompts) { out[p.savedSearch] ='
        + ' p.spl; } return out; })();';
    const catBad3z = [];
    [['CATALOG_SPLS', CAT_3Z], ['SAVED_SEARCH_SPL', SSS_3Z]].forEach(([nm, want]) => {
        const st = modStmt3z(nm);
        if (!st || norm3z(st.getText(hookSf3z)) !== want) catBad3z.push(`${nm} is not one module-level const \`${want}\``);
    });
    if (idsOf3z(hookSf3z, 'CATALOG_SPLS') !== 2 || !atStmt3z || idsOf3z(atStmt3z, 'CATALOG_SPLS') !== 1) {
        catBad3z.push(`CATALOG_SPLS named ${idsOf3z(hookSf3z, 'CATALOG_SPLS')} times - only its declaration and the`
            + ' authorTexts statement');
    }
    const CLIMB_3Z = [K3z.ParenthesizedExpression, K3z.ArrayLiteralExpression, K3z.SpreadElement, K3z.PropertyAssignment,
        K3z.ShorthandPropertyAssignment, K3z.ObjectLiteralExpression, K3z.NonNullExpression, K3z.AsExpression,
        K3z.TypeAssertionExpression, K3z.SatisfiesExpression];
    eachNode3z(hookSf3z, (n) => {
        if (n.kind !== K3z.Identifier || n.text !== 'SAVED_SEARCH_SPL') return;
        const p = n.parent;
        if (DECL_3Z.indexOf(p.kind) !== -1 && p.name === n) return;
        let ok = false;
        if (p.kind === K3z.ElementAccessExpression && p.expression === n) {
            let c = p;
            let q = c.parent;
            while (q && CLIMB_3Z.indexOf(q.kind) !== -1) {
                c = q;
                q = q.parent;
            }
            ok = !(q && ((q.kind === K3z.BinaryExpression && q.left === c && q.operatorToken.kind >= K3z.FirstAssignment
                && q.operatorToken.kind <= K3z.LastAssignment)
                || ((q.kind === K3z.ForInStatement || q.kind === K3z.ForOfStatement) && q.initializer === c)
                || q.kind === K3z.DeleteExpression
                || ((q.kind === K3z.PrefixUnaryExpression || q.kind === K3z.PostfixUnaryExpression)
                    && (q.operator === K3z.PlusPlusToken || q.operator === K3z.MinusMinusToken))));
        }
        if (p.kind === K3z.CallExpression && p.arguments.length === 2 && p.arguments[0] === n
            && norm3z(p.expression.getText(hookSf3z)) === 'Object.prototype.hasOwnProperty.call') ok = true;
        if (!ok) catBad3z.push(`SAVED_SEARCH_SPL used in \`${norm3z(p.getText(hookSf3z)).slice(0, 80)}\``);
    });
    p3z('(f) catalog SPL bindings', catBad3z.length === 0,
        `[${catBad3z.join(' / ')}] - the catalog's author text is the intent map's spl, read and never changed`);
    const spls3z = prompts3z.map((p) => (p ? p.spl : undefined));
    const shipBad3z = prompts3z.filter((p) => !p || typeof p.spl !== 'string' || typeof p.savedSearch !== 'string'
        || p.spl !== search3z(bodies3z[p.savedSearch])).map((p) => (p && p.savedSearch) || '(no name)');
    p3z('(f) catalog SPL shipped', prompts3z.length > 0 && shipBad3z.length === 0,
        `[${shipBad3z.join(', ')}] - every intent-map prompt's spl must be the search line of its savedsearches.conf`
        + ' stanza, byte for byte: the catalog author text is the SPL that ships');
    // Round 7: the naming rule's two halves, through the module the hook
    // imports. FIXED_COLUMN_NAMES - sent by name whatever the author text says
    // - is pinned: only a name Splunk itself generates belongs there, so each
    // addition is reviewed here. And the catalog's author words are exactly
    // the words of the shipped SPL ([A-Za-z0-9_]+, read here independently,
    // quoted text included - App-written text tells the vendor nothing new);
    // with them every field-shaped catalog word is sendable, and a name with a
    // word outside them (a case variant included) is not; with no author text
    // only FIXED names are.
    const VCT_3Z = path.join(HOME_3Z, 'utils', 'vendorColumnText');
    const FIXED_3Z = ['NULL', 'OTHER', 'Total', 'avg', 'column', 'count', 'dc', 'distinct_count', 'earliest', 'field',
        'first', 'is_exact', 'last', 'latest', 'max', 'mean', 'median', 'min', 'mode', 'numeric_count', 'percent', 'range',
        'rate', 'stdev', 'sum', 'total', 'values'];
    let vct3z = null;
    let vctErr3z = '';
    try {
        vct3z = loadTs(VCT_3Z);
    } catch (e) {
        vctErr3z = `vendorColumnText does not load: ${String(e && e.message ? e.message : e)}`;
    }
    const fixedSet3z = vct3z && vct3z.FIXED_COLUMN_NAMES instanceof Set ? vct3z.FIXED_COLUMN_NAMES : null;
    const fixed3z = fixedSet3z ? Array.from(fixedSet3z).sort() : [];
    const fixedAdded3z = fixed3z.filter((n) => FIXED_3Z.indexOf(n) === -1);
    const fixedGone3z = FIXED_3Z.filter((n) => fixed3z.indexOf(n) === -1);
    p3z('(f) fixed names', !!fixedSet3z && fixedAdded3z.length === 0 && fixedGone3z.length === 0,
        `${vctErr3z || (fixedSet3z ? '' : 'no FIXED_COLUMN_NAMES set;')} added [${fixedAdded3z.join(', ')}], gone`
        + ` [${fixedGone3z.join(', ')}] - FIXED_COLUMN_NAMES is sent by name with no author text: review each name`
        + ' (only one Splunk itself generates) and update FIXED_3Z');
    const words3z = new Set();
    spls3z.forEach((s) => {
        if (typeof s === 'string') (s.match(/[A-Za-z0-9_]+/g) || []).forEach((w) => words3z.add(w));
    });
    const PROBES_3Z = ['s149_probe_value', 'jsmith', 'values(s149_probe_value)', 'host.s149q', 'col_1'];
    const wordBad3z = [];
    if (!vct3z || typeof vct3z.buildAuthorContext !== 'function' || typeof vct3z.isSendableColumnName !== 'function'
        || !vct3z.NO_AUTHOR) {
        wordBad3z.push(vctErr3z || 'vendorColumnText exports no buildAuthorContext / isSendableColumnName / NO_AUTHOR');
    } else {
        const ctx = vct3z.buildAuthorContext(spls3z);
        const got = ctx && ctx.words instanceof Set ? ctx.words : null;
        if (!got) {
            wordBad3z.push('buildAuthorContext(catalog SPL).words is not a Set');
        } else {
            const added = Array.from(got).filter((w) => !words3z.has(w));
            const gone = Array.from(words3z).filter((w) => !got.has(w));
            if (added.length || gone.length) {
                wordBad3z.push(`buildAuthorContext(catalog SPL) has ${got.size} words, the shipped SPL ${words3z.size} -`
                    + ` added [${added.slice(0, 12).join(', ')}], gone [${gone.slice(0, 12).join(', ')}]`);
            }
        }
        [[], [42, null, {}, ['user']]].forEach((t, i) => {
            const c = vct3z.buildAuthorContext(t);
            if (!(c && c.words instanceof Set && c.words.size === 0)) wordBad3z.push(`buildAuthorContext(no text ${i + 1}) has words`);
        });
        const isFixed = (w) => !!fixedSet3z && fixedSet3z.has(w);
        const shaped = Array.from(words3z).filter((w) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(w));
        const withheld = shaped.filter((w) => !vct3z.isSendableColumnName(w, ctx));
        if (withheld.length) wordBad3z.push(`field-shaped catalog words withheld with the catalog author text [${withheld.slice(0, 12).join(', ')}]`);
        const bare = shaped.filter((w) => !isFixed(w) && vct3z.isSendableColumnName(w, vct3z.NO_AUTHOR));
        if (bare.length) wordBad3z.push(`sent with no author text [${bare.slice(0, 12).join(', ')}]`);
        const cased = shaped.map((w) => w.toUpperCase()).filter((w) => !words3z.has(w) && !isFixed(w)).slice(0, 40);
        const probes = PROBES_3Z.concat(cased);
        const inCat = PROBES_3Z.filter((p) => (p.match(/[A-Za-z0-9_]+/g) || []).every((w) => words3z.has(w)));
        if (inCat.length) wordBad3z.push(`probe(s) [${inCat.join(', ')}] are all catalog words - pick a probe with a word outside it`);
        const sent = probes.filter((p) => vct3z.isSendableColumnName(p, ctx));
        if (cased.length < 20 || sent.length) {
            wordBad3z.push(`sent with the catalog author text though a word is not the catalog's [${sent.slice(0, 12).join(', ')}]`
                + ` (${cased.length} case probes)`);
        }
    }
    p3z('(f) author words', wordBad3z.length === 0,
        `${wordBad3z.join('; ')} - a column name is sent only when Splunk generates it or every word of it is author text`);
    // Round 8 (the product owner's decision: Tier 2 values fail closed). With
    // redaction on, a column's text values are sent in clear only when the
    // column is named and TRACED SAFE - defined only through constructs the
    // reader fully understands (the field itself, fn(field) and nested
    // stat functions, AS aliases, a non-wildcard rename, eval of one bare or
    // single-quoted field, lookup OUTPUT, a count), not a count, not a pivot
    // cell, not mixed, and no identifier among its own name and the fields
    // it reads. Every other construct - another eval expression, rex, spath,
    // strcat, a wildcard rename or AS, a dynamic target, transpose / untable,
    // a subsearch-defined column, an unknown command, any cap exceeded - is
    // untraced, and its values are hashed; a numeric column's statistics are
    // withheld when it is not a count and marks an identifier, or is mixed.
    // '(f) value caps': the four bounds the docs quote, exactly.
    // '(f) value rule': columnValueRule and the redaction steps of
    // vendorColumnLines, statement for statement (printed without comments).
    // '(f) values fail closed': one probe per untraced construct and per cap,
    // through vendorColumnLines - with redaction on the column is named and
    // no raw value (no numeric statistic) is sent; with it off the raw value
    // is sent, so the probe column is summarized at all.
    // '(f) identifier values': traced identifier columns (dotted CIM / JSON
    // names, src / dest / dvc, an alias of one) are hashed too.
    // '(f) traced values sent': traced-safe columns keep their values in
    // clear (and dest_port, datasrc are not identifiers).
    // '(f) Tier 2 primer': SYSTEM_PRIMER_TIER2's TIER 2 SUMMARY SHAPES block
    // names every placeholder a summary can carry, each read from the code
    // that emits it.
    const CAPS_3Z = { MAX_QUERY_CHARS: 20000, MAX_TRACE_COMMANDS: 256, MAX_SUBSEARCH_DEPTH: 8, MAX_SOURCE_STEPS: 64,
        MAX_WILDCARD_PATTERNS: 12 };
    const capBad3z = Object.keys(CAPS_3Z).filter((k) => !vct3z || vct3z[k] !== CAPS_3Z[k])
        .map((k) => `${k}=${vct3z ? vct3z[k] : '?'}`);
    p3z('(f) value caps', capBad3z.length === 0,
        `[${capBad3z.join(', ')}] - the Tier 2 trace bounds the privacy docs quote (`
        + `${Object.keys(CAPS_3Z).map((k) => `${k} ${CAPS_3Z[k]}`).join(', ')}): review the docs and update CAPS_3Z`);
    const vctFile3z = `${VCT_3Z}.ts`;
    const vctSf3z = ast3z(fs.existsSync(vctFile3z) ? fs.readFileSync(vctFile3z, 'utf8') : '', vctFile3z);
    const printer3z = ts.createPrinter({ removeComments: true });
    const printed3z = (n) => norm3z(printer3z.printNode(ts.EmitHint.Unspecified, n, vctSf3z));
    const vctArrow3z = (name) => {
        const hits = [];
        vctSf3z.statements.forEach((st) => {
            if (st.kind !== K3z.VariableStatement || (st.declarationList.flags & ts.NodeFlags.Const) === 0) return;
            st.declarationList.declarations.forEach((d) => {
                if (d.name.kind === K3z.Identifier && d.name.text === name) hits.push(d);
            });
        });
        return hits.length === 1 && hits[0].initializer && hits[0].initializer.kind === K3z.ArrowFunction
            && hits[0].initializer.body.kind === K3z.Block ? hits[0].initializer : null;
    };
    const CVR_3Z = ['const trace = traceColumn(name, author);',
        'const identifier = isIdentifierColumnName(name, piiOpts) || trace.fields.some((f) => isIdentifierColumnName(f,'
            + ' piiOpts));',
        'return { trace, identifier, textSafe: trace.traced && !trace.count && !trace.cell && !trace.mixed && !identifier,'
            + ' numericIdentifier: !trace.count && (identifier || trace.mixed), };'];
    const VCL_DECL_3Z = {
        redactOn: ['const redactOn = piiOpts.enabled !== false;', 2],
        rule: ['const rule = columnValueRule(col.name, author, piiOpts);', 3],
        disclosure: ['const disclosure = numericDisclosure(col.named, rule.numericIdentifier, f.distinct, piiOpts);', 3],
        redactAll: ['const redactAll = redactOn && (!col.named || !rule.textSafe);', 2],
    };
    const RED_IF_3Z = "if (redactAll && sanitized !== '<filtered>') { const redacted = redactValueIfPII(PII_STAND_IN_COLUMN,"
        + ' sanitized, piiOpts); if (redacted !== sanitized) { valueOut = redacted; if (opts.onRedaction)'
        + ' opts.onRedaction(); } }';
    const ruleBad3z = [];
    const cvr3z = vctArrow3z('columnValueRule');
    const cvrGot3z = cvr3z ? cvr3z.body.statements.map(printed3z) : null;
    if (!cvrGot3z || JSON.stringify(cvrGot3z) !== JSON.stringify(CVR_3Z)) {
        const diff = cvrGot3z ? cvrGot3z.find((s, i) => s !== CVR_3Z[i]) : undefined;
        ruleBad3z.push(`columnValueRule is not exactly the ${CVR_3Z.length} pinned statements`
            + (cvrGot3z ? ` (found ${cvrGot3z.length}${diff ? `; differs at \`${diff.slice(0, 160)}\`` : ''})`
                : ' (no module-level const arrow)'));
    }
    const vcl3z = vctArrow3z('vendorColumnLines');
    if (!vcl3z) {
        ruleBad3z.push('no module-level const arrow vendorColumnLines');
    } else {
        Object.keys(VCL_DECL_3Z).forEach((nm) => {
            const [want, refs] = VCL_DECL_3Z[nm];
            const decls = [];
            eachNode3z(vcl3z.body, (n) => {
                if (n.kind === K3z.VariableDeclaration && n.name.kind === K3z.Identifier && n.name.text === nm) decls.push(n);
            });
            const got = decls.length === 1 ? printed3z(decls[0].parent.parent) : null;
            if (got !== want || idsOf3z(vcl3z.body, nm) !== refs) {
                ruleBad3z.push(`vendorColumnLines: ${decls.length} declaration(s) of ${nm}, named`
                    + ` ${idsOf3z(vcl3z.body, nm)} times - want one \`${want}\`, named ${refs} times`);
            }
        });
        const ifs = [];
        eachNode3z(vcl3z.body, (n) => {
            if (n.kind === K3z.IfStatement && printed3z(n.expression) === "redactAll && sanitized !== '<filtered>'") ifs.push(n);
        });
        if (ifs.length !== 1 || printed3z(ifs[0]) !== RED_IF_3Z) {
            ruleBad3z.push(`vendorColumnLines: ${ifs.length} redaction step(s) - want one \`${RED_IF_3Z}\``);
        }
        if (idsOf3z(vcl3z.body, 'redactValueIfPII') !== 1) {
            ruleBad3z.push(`vendorColumnLines names redactValueIfPII ${idsOf3z(vcl3z.body, 'redactValueIfPII')} times (once)`);
        }
    }
    if (!vct3z || vct3z.PII_STAND_IN_COLUMN !== 'user') {
        ruleBad3z.push(`PII_STAND_IN_COLUMN is ${vct3z ? JSON.stringify(vct3z.PII_STAND_IN_COLUMN) : '?'}, not 'user'`);
    }
    p3z('(f) value rule', ruleBad3z.length === 0,
        `[${ruleBad3z.join(' / ')}] - a Tier 2 value is sent in clear only when its column is named and traced safe:`
        + ' review any change to the rule here');
    // The probes: one SPL, the column it outputs, numeric or text.
    const SENT_3Z = 'zq149sentinel';
    const nest3z = (n) => `index=x ${'| append [search index=y '.repeat(n)}| eval w=a${' ]'.repeat(n)} | table w`;
    const FAIL_CLOSED_3Z = [
        ['eval concatenation', 'index=x | eval w=a.b | stats count by w', 'w'],
        ['eval function', 'index=x | eval w=lower(a) | stats count by w', 'w'],
        ['eval coalesce', 'index=x | eval w=coalesce(a, b) | stats count by w', 'w'],
        ['rex', 'index=x | rex field=a "(?<w>\\w+)" | stats count by w', 'w'],
        ['spath', 'index=x | spath | stats count by w', 'w'],
        ['strcat', 'index=x | strcat a b w | stats count by w', 'w'],
        ['wildcard rename', 'index=x | rename a* as w* | stats count by wx', 'wx'],
        ['wildcard AS', 'index=x | stats values(*) as *_v by h | table a_v', 'a_v'],
        ['dynamic eval target', 'index=x | eval {k}=a | table w', 'w'],
        ['transpose', 'index=x | stats count by a | transpose | table w', 'w'],
        ['untable', 'index=x | untable a w v | table w', 'w'],
        ['pivot text cell', 'index=x | xyseries a b w | table q', 'q'],
        ['subsearch-defined', 'index=x | table w | append [search index=y | eval w=a]', 'w'],
        ['foreach', 'index=x | foreach a [eval w=a] | table w', 'w'],
        ['unknown command', 'index=x | s149unknowncmd | table w', 'w'],
        ['count holding text', 'index=x | stats count by a | table count', 'count'],
        ['MAX_QUERY_CHARS', `index=x | table w${' '.repeat(CAPS_3Z.MAX_QUERY_CHARS)}`, 'w'],
        ['MAX_TRACE_COMMANDS', `index=x${' | fields w'.repeat(CAPS_3Z.MAX_TRACE_COMMANDS + 1)}`, 'w'],
        ['MAX_SUBSEARCH_DEPTH', nest3z(CAPS_3Z.MAX_SUBSEARCH_DEPTH + 2), 'w'],
        ['MAX_SOURCE_STEPS (numeric)', `index=x | eval n=coalesce(${Array.from({ length: CAPS_3Z.MAX_SOURCE_STEPS + 6 },
            (_x, i) => `a${i}`).join(',')},src_user) | table n`, 'n', true],
        ['untraced numeric over an identifier', 'index=x | eval n=a.user | table n', 'n', true],
        // Security review of build 377: makemv cuts a field into pieces (a tokenizer regex, a delimiter).
        ['makemv tokenizer', 'index=x | eval m=_raw | makemv tokenizer="u=(\\S+)" m | stats count by m', 'm'],
        ['makemv delim', 'index=x | eval m=_raw | makemv delim=" " m | stats count by m', 'm'],
    ];
    const IDENT_3Z = [
        ['user', 'index=x | stats count by user', 'user'],
        ['Authentication.user', '| tstats count from datamodel=Authentication by Authentication.user', 'Authentication.user'],
        ['All_Traffic.src_ip', '| tstats count from datamodel=Network_Traffic by All_Traffic.src_ip', 'All_Traffic.src_ip'],
        ['event.user', 'index=x | stats count by event.user', 'event.user'],
        ['src', 'index=x | stats count by src', 'src'],
        ['dest', 'index=x | stats count by dest', 'dest'],
        ['dvc', 'index=x | stats count by dvc', 'dvc'],
        ['fw_src', 'index=x | stats count by fw_src', 'fw_src'],
        ['src_host', 'index=x | stats count by src_host', 'src_host'],
        ['rename of src_user', 'index=x | rename src_user as w | stats count by w', 'w'],
        ['numeric over user_id', 'index=x | stats latest(user_id) as n by a', 'n', true],
        // Security review of build 377: rollup columns that hold user names or addresses, and raw LogServ names.
        ['compliance operator', '| inputlookup logserv_compliance_rollup | stats sum(count) as n by operator', 'operator'],
        ['topology scope', '| inputlookup logserv_topology_detail_rollup | stats sum(count) as n by scope', 'scope'],
        ['topology error_detail', '| inputlookup logserv_topology_detail_rollup | stats sum(count) as n by error_detail', 'error_detail'],
        ['topology spl_filter_clauses', '| inputlookup logserv_topology_edges | stats count by spl_filter_clauses', 'spl_filter_clauses'],
        ['pam rhost', 'index=x | stats count by rhost', 'rhost'],
        ['sudo PWD', 'index=x | stats count by PWD', 'PWD'],
        ['Windows IpAddress', 'index=x | stats count by IpAddress', 'IpAddress'],
        ['Windows TargetUserSid', 'index=x | stats count by TargetUserSid', 'TargetUserSid'],
    ];
    const SAFE_3Z = [
        ['by field', 'index=x | stats count by action', 'action'],
        ['rename', 'index=x | rename sourcetype as st | stats count by st', 'st'],
        ['eval bare field', 'index=x | eval w=action | stats count by w', 'w'],
        ['eval quoted field', "index=x | eval w='action' | stats count by w", 'w'],
        ['quoted display alias', 'index=x | stats count by sourcetype | rename sourcetype as "Source Type"', 'Source Type'],
        ['fn(field) AS', 'index=x | stats latest(action) as w by h', 'w'],
        ['top', 'index=x | top limit=5 process_name', 'process_name'],
        ['dest_port', 'index=x | stats count by dest_port', 'dest_port'],
        ['datasrc', 'index=x | stats count by datasrc', 'datasrc'],
        ['count (numeric)', 'index=x | stats count as n by action', 'n', true],
    ];
    const probe3z = ([what, spl, col, numeric]) => {
        const out = (pii) => vct3z.vendorColumnLines([1, 2, 3].map((i) => ({ [col]: numeric ? 1000 + i : `${SENT_3Z}${i}` })),
            { topN: 10, sanitizeValue: (x) => x, piiOpts: pii, author: vct3z.buildAuthorContext([spl]) }).join('\n');
        const shows = (s) => (numeric ? /\bmin=/.test(s) : s.indexOf(SENT_3Z) !== -1);
        const on = out({});
        return { what, on: shows(on), off: shows(out({ enabled: false })), named: on.indexOf(`Column "${col}"`) !== -1, text: on };
    };
    const runProbes3z = (table) => {
        try {
            return vct3z ? table.map(probe3z) : null;
        } catch (e) {
            return null;
        }
    };
    const fc3z = runProbes3z(FAIL_CLOSED_3Z);
    const idv3z = runProbes3z(IDENT_3Z);
    const safe3z = runProbes3z(SAFE_3Z);
    const hidden3z = (rs) => (rs ? rs.filter((r) => !(r.named && !r.on && r.off)).map((r) => `${r.what}${r.on ? ' SENT' : ''}`
        + `${r.named ? '' : ' (name withheld)'}${r.off ? '' : ' (not summarized)'}`) : ['vendorColumnText does not load']);
    p3z('(f) values fail closed', hidden3z(fc3z).length === 0,
        `[${hidden3z(fc3z).join(', ')}] - with redaction on, a column the reader cannot trace through understood`
        + ' constructs (or past a cap) must be named and carry no raw value or numeric statistic; with it off the value is sent');
    p3z('(f) identifier values', hidden3z(idv3z).length === 0,
        `[${hidden3z(idv3z).join(', ')}] - with redaction on, a traced column whose name or source field marks an`
        + ' identifier (user, dotted CIM / JSON names, src / dest / dvc) is hashed');
    // Security review of build 377: a `bin` / `bucket` of another field into `_time` is a computed `_time`
    // (the range is withheld); a time source field binned into `_time` keeps the range; 20 stacked appendpipe
    // groups are read in well under a second (each group used to double the cost: about 7 s at 20).
    const review3z = [];
    try {
        const tra = (q) => vct3z.timeRangeAllowed(vct3z.buildAuthorContext([q]));
        if (tra('index=x | eval n=tonumber(substr(user,2)) | bin n span=1 AS _time | stats count by _time')) {
            review3z.push('bin n AS _time keeps the range');
        }
        if (tra('index=x | bucket bytes span=1 AS _time | table _time')) review3z.push('bucket bytes AS _time keeps the range');
        if (!tra('| inputlookup logserv_mc_rollup | bin bucket_ts span=1d AS _time | table _time')) {
            review3z.push('bin bucket_ts AS _time withholds the range');
        }
        const t03z = Date.now();
        vct3z.vendorColumnLines([{ metric: 'a', count: 1 }, { metric: 'b', count: 2 }], { topN: 10, sanitizeValue: (x) => x,
            piiOpts: {}, author: vct3z.buildAuthorContext([`| inputlookup logserv_mc_rollup${' | appendpipe [ spath ]'.repeat(20)}`]) });
        const ms3z = Date.now() - t03z;
        if (ms3z >= 1000) review3z.push(`20 stacked appendpipe groups took ${ms3z} ms`);
    } catch (e) {
        review3z.push(`vendorColumnText threw: ${e && e.message}`);
    }
    p3z('(f) security review probes', !!vct3z && review3z.length === 0,
        `[${review3z.join(', ')}] - bin / bucket <field> AS _time must withhold the time range (a time source field keeps`
        + ' it), and stacked appendpipe groups must be read in linear time');
    const safeBad3z = safe3z ? safe3z.filter((r) => !(r.named && r.on)).map((r) => r.what) : ['vendorColumnText does not load'];
    p3z('(f) traced values sent', safeBad3z.length === 0,
        `[${safeBad3z.join(', ')}] - with redaction on, a traced-safe column keeps its name and its values in clear`);
    // The primer: the literal text of systemMessage(...) in the one
    // module-level SYSTEM_PRIMER_TIER2, named once more where it is used. A
    // shared constant it concatenates (the catalog, the data model) is a gap
    // no placeholder can span.
    const litText3z = (e) => {
        if (!e) return null;
        if (e.kind === K3z.NoSubstitutionTemplateLiteral || e.kind === K3z.StringLiteral) return e.text;
        if (e.kind === K3z.ParenthesizedExpression) return litText3z(e.expression);
        if (e.kind === K3z.Identifier) return '\u0000';
        if (e.kind === K3z.BinaryExpression && e.operatorToken.kind === K3z.PlusToken) {
            const l = litText3z(e.left);
            const r = litText3z(e.right);
            return l === null || r === null ? null : l + r;
        }
        return null;
    };
    const primSt3z = modStmt3z('SYSTEM_PRIMER_TIER2');
    const primInit3z = primSt3z ? primSt3z.declarationList.declarations[0].initializer : null;
    const primer3z = primInit3z && primInit3z.kind === K3z.CallExpression && primInit3z.expression.kind === K3z.Identifier
        && primInit3z.expression.text === 'systemMessage' && primInit3z.arguments.length === 1
        ? litText3z(primInit3z.arguments[0]) : null;
    const SHAPES_OPEN_3Z = '=== TIER 2 SUMMARY SHAPES';
    const SHAPES_CLOSE_3Z = '=== END TIER 2 SUMMARY SHAPES ===';
    const shapesAt3z = primer3z === null ? -1 : primer3z.indexOf(SHAPES_OPEN_3Z);
    const shapesEnd3z = shapesAt3z === -1 ? -1 : primer3z.indexOf(SHAPES_CLOSE_3Z, shapesAt3z);
    const shapes3z = shapesEnd3z === -1 ? '' : primer3z.slice(shapesAt3z, shapesEnd3z);
    const primBad3z = [];
    if (primer3z === null) primBad3z.push('SYSTEM_PRIMER_TIER2 is not one module-level const systemMessage(<literal text>)');
    else if (!shapes3z) primBad3z.push(`no ${SHAPES_OPEN_3Z} ... ${SHAPES_CLOSE_3Z} block`);
    if (idsOf3z(hookSf3z, 'SYSTEM_PRIMER_TIER2') !== 2) {
        primBad3z.push(`SYSTEM_PRIMER_TIER2 named ${idsOf3z(hookSf3z, 'SYSTEM_PRIMER_TIER2')} times (its declaration and one use)`);
    }
    let tag3z = '';
    let withheldVals3z = '';
    try {
        const pii = loadTs(path.join(path.dirname(VCT_3Z), 'piiRedaction'));
        const t = String(pii.redactValueIfPII('user', 's149', {}));
        tag3z = /^<[a-z]+-/.test(t) ? t.slice(0, t.indexOf('-') + 1) : '';
        // A numeric constant under a withheld name: withheld whatever the value rule says.
        const wl = vct3z ? vct3z.vendorColumnLines([{ s149zz: 5 }], { topN: 10, sanitizeValue: (x) => x }).join('\n') : '';
        const m = /\(numeric, distinct=1\): ([a-z ]+)\./.exec(wl);
        withheldVals3z = m ? m[1] : '';
    } catch (e) {
        primBad3z.push(`piiRedaction does not load: ${String(e && e.message ? e.message : e)}`);
    }
    const shapeWords3z = [
        vct3z ? `${vct3z.PLACEHOLDER_PREFIX}N` : '',
        vct3z ? vct3z.withheldNote(1).split(':')[0] : '',
        tag3z,
        withheldVals3z,
        T2_TAIL_3Z[2].match(/`(Returned a result that is not in row form)/)[1],
        vct3z ? vct3z.TIME_NOT_SHOWN.split(' (')[0] : '',
    ];
    shapeWords3z.forEach((w, i) => {
        if (!w) primBad3z.push(`placeholder ${i + 1} could not be read from the code that emits it`);
        else if (shapes3z && shapes3z.indexOf(w) === -1) primBad3z.push(`the block does not name "${w}"`);
    });
    p3z('(f) Tier 2 primer', primBad3z.length === 0,
        `[${primBad3z.join(' / ')}] - the Tier 2 primer must explain every placeholder a summary can carry (col_N,`
        + ' withheld names, redaction tags, withheld values, not in row form, time not shown)');
    console.log(`check-diagnostics: 3z ${intent3z.length} catalog searches read-only (${alerting3z} raise only`
        + ` notable / risk); ${writers3z.length} writing stanzas, none in the catalog or allowed;`
        + ` runSavedSearch, splGuard and the dispatcher pinned; ${walked3z} files read for forwarding;`
        + ` ${Object.keys(macroDefs3z).length} macro definitions read-only; the vendor sees no Splunk or MCP text`
        + ` (${mvCalls3z.length} markVisible calls checked), and Tier 2 column names and times only through`
        + ` vendorColumnLines (a name only when Splunk generates it - ${fixed3z.length} fixed names pinned - or every`
        + ` word of it is author text: the model's own query, or the shipped catalog SPL, ${words3z.size} words);`
        + ` Tier 2 values fail closed (${FAIL_CLOSED_3Z.length} untraced and cap probes hashed,`
        + ` ${IDENT_3Z.length} identifier probes hashed, ${SAFE_3Z.length} traced-safe probes sent)`);
}

// --- 3icm: dev_icm's SAP client is not an HTTP status (build 378, item icm) -
//
// A dev_icm session-list line reads "<type> T<n>_U<n>_M<n>, <client>, <user>,
// <terminal>, time=...": the three digits after the session ID are the SAP
// client (Mandant), and no dev_icm line carries an HTTP status. Until build 378
// they were extracted as icm_status_code, aliased to the CIM status and
// action, turned into icm_is_error (clients 400-599) and charted as 2xx..5xx
// status classes (clients 200 and 000 on Demo Gen). These pins hold the fix in
// every file it touches; the field behaviour is icmProps.consistency-test.
//  (a) props [sap:abap:icm]: no icm_status_code, nothing aliased or evaluated
//      into status / action, the client is sap_client, the message class
//      icm_severity is anchored, icm_is_error is the ERROR line.
//  (b) sap:abap:icm is in no eventtype / tag (dev_icm has no Web request).
//  (c) the severity and abapnet rollups: no arm reads icm_status_code or writes
//      metric="icmstat"; each carries the icmsev arm, abapnet also icmclient
//      (by SID and client: a client number belongs to its system), the
//      abapnet key adds sap_client only on rows that carry it (every other
//      metric keeps its key), each aggregate equals its backfill byte for byte.
//  (d) the abapnet collection and lookup carry the sap_client column.
//  (e) no App source or AI catalog text reads icm_status_code or icmstat; the
//      ICM panels' cached and raw twins read the same facts; the ICM Peers
//      table counts connections (a connection line has no session ID); the
//      AI-facing sourcetype metadata row offers no HTTP status.
{
    const ROOT_ICM = path.resolve(__dirname, '..');
    const DEF_ICM = path.join(ROOT_ICM, 'src/main/resources/splunk/default');
    const HOME_ICM = path.join(ROOT_ICM, 'src/main/webapp/pages/home');
    const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    let nIcm = 0;
    let badIcm = 0;
    const pIcm = (label, ok, detail) => {
        nIcm += 1;
        if (!ok) {
            badIcm += 1;
            console.error(`check-diagnostics: 3icm ${label}: ${detail}`);
            failed = true;
        }
    };
    const live = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l));
    const stanzasIcm = (text) => {
        const out = {};
        let cur = null;
        text.split('\n').forEach((line) => {
            const m = /^\[(.+)\]\s*$/.exec(line.trim());
            if (m) {
                cur = m[1];
                out[cur] = [];
            } else if (cur && !/^\s*#/.test(line) && line.trim() !== '') {
                out[cur].push(line);
            }
        });
        return out;
    };
    const keyIcm = (lines, k) => {
        const ls = (lines || []).filter((l) => l.startsWith(`${k} = `));
        return ls.length ? ls[ls.length - 1].slice(k.length + 3) : null;
    };

    // ---- (a) props --------------------------------------------------------
    const icm = stanzasIcm(rd(path.join(DEF_ICM, 'props.conf')))['sap:abap:icm'] || [];
    pIcm('(a) stanza', icm.length > 10, `[sap:abap:icm] has ${icm.length} live lines`);
    pIcm('(a) no icm_status_code', !icm.some((l) => /\bicm_status_code\b/.test(l)),
        'the three digits after a session ID are the SAP client (sap_client), not an HTTP status');
    pIcm('(a) no status / action', !icm.some((l) => /^FIELDALIAS-[^=]*=.*\bAS\s+(status|action)\b/i.test(l)
        || /^EVAL-(status|action)\s*=/.test(l) || /\(\?<(status|action)>/.test(l)),
    'dev_icm records no HTTP status: nothing may alias, evaluate or extract status or action');
    pIcm('(a) sap_client', keyIcm(icm, 'EXTRACT-sap_client') === 'T\\d+_U\\d+_M\\d+,\\s*(?<sap_client>\\d{3})(?=\\s*,)',
        `EXTRACT-sap_client is ${JSON.stringify(keyIcm(icm, 'EXTRACT-sap_client'))}`);
    const sevIcm = keyIcm(icm, 'EXTRACT-icm_severity') || '';
    pIcm('(a) icm_severity anchored', /^\^\\s\*/.test(sevIcm) && /\(\?<icm_severity>ERROR\|WARNING\)/.test(sevIcm),
        `EXTRACT-icm_severity must start with ^\\s* and capture ERROR|WARNING: ${sevIcm}`);
    pIcm('(a) icm_is_error', keyIcm(icm, 'EVAL-icm_is_error') === 'if(icm_severity=="ERROR", "true", "false")',
        `EVAL-icm_is_error is ${JSON.stringify(keyIcm(icm, 'EVAL-icm_is_error'))}`);

    // ---- (b) no CIM model -------------------------------------------------
    const etIcm = live(rd(path.join(DEF_ICM, 'eventtypes.conf'))).filter((l) => /sap:abap:icm/.test(l));
    pIcm('(b) eventtypes', etIcm.length === 0, `an eventtype selects sap:abap:icm: ${etIcm.join(' | ')}`);
    pIcm('(b) tags', !/^\[eventtype=sap_abap_icm_request\]/m.test(rd(path.join(DEF_ICM, 'tags.conf'))),
        'tags.conf still tags sap_abap_icm_request');

    // ---- (c) the rollups ----------------------------------------------------
    const ssText = rd(path.join(DEF_ICM, 'savedsearches.conf'));
    const ss = stanzasIcm(ssText);
    const ssLive = live(ssText).join('\n');
    pIcm('(c) no icm_status_code', !/\bicm_status_code\b/.test(ssLive), 'a saved search reads icm_status_code');
    pIcm('(c) no icmstat', !/metric="icmstat"/.test(ssLive), 'a saved search writes or reads metric="icmstat"');
    const SEV_ARM = '[search `sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_severity=* | eval cloud_provider=coalesce(cloud_provider,"aws") | eval status_cat=icm_severity | bin _time span=1h | stats count by status_cat, _time, cloud_provider | rename _time as bucket_ts | eval metric="icmsev"]';
    const CLIENT_ARM = '[search `sap_logserv_idx_macro` sourcetype="sap:abap:icm" sap_client=* | eval cloud_provider=coalesce(cloud_provider,"aws") | fillnull value="(none)" sap_sid | bin _time span=1h | stats count by sap_sid, sap_client, _time, cloud_provider | rename _time as bucket_ts | eval metric="icmclient"]';
    const ERR_PRED = '(sourcetype="sap:abap:icm" icm_is_error="true")';
    const count = (s, sub) => s.split(sub).length - 1;
    const sevAgg = keyIcm(ss.logserv_severity_aggregate, 'search') || '';
    const sevBf = keyIcm(ss.logserv_severity_backfill, 'search') || '';
    pIcm('(c) severity icmsev', count(sevAgg, SEV_ARM) === 1, 'logserv_severity_aggregate must carry the icmsev arm once');
    pIcm('(c) severity ICM errors', count(sevAgg, ERR_PRED) === 3,
        `toterr, trend and tophost count an ICM error as icm_is_error="true" (found ${count(sevAgg, ERR_PRED)})`);
    pIcm('(c) severity backfill = aggregate', sevAgg !== '' && sevBf === sevAgg,
        'logserv_severity_backfill must run the aggregate\'s search byte for byte');
    const netAgg = keyIcm(ss.logserv_abapnet_aggregate, 'search') || '';
    const netBf = keyIcm(ss.logserv_abapnet_backfill, 'search') || '';
    pIcm('(c) abapnet icmsev + icmclient', count(netAgg, SEV_ARM) === 1 && count(netAgg, CLIENT_ARM) === 1,
        'logserv_abapnet_aggregate must carry the icmsev and icmclient arms once each');
    pIcm('(c) abapnet icmerr', count(netAgg, '[search `sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_is_error="true" |') === 1,
        'the ICM Errors KPI metric counts icm_is_error="true" (an ERROR line)');
    pIcm('(c) abapnet key', count(netAgg, '. ":" . coalesce(gw_service,"") . if(isnull(sap_client), "", ":" . sap_client)), 1, 24) . ":" . cloud_provider . ":" . bucket_ts') === 1,
        'the abapnet _key must add ":" . sap_client only when the row carries one (two clients would share a key without it; every other metric keeps its key)');
    pIcm('(c) abapnet fields', / \| fields _key, [^|]*\bsap_client\b[^|]*\| outputlookup append=true logserv_abapnet_rollup$/.test(netAgg),
        'the abapnet tail must keep sap_client through | fields');
    pIcm('(c) abapnet backfill = aggregate', netAgg !== '' && netBf === netAgg,
        'logserv_abapnet_backfill must run the aggregate\'s search byte for byte');

    // ---- (d) the collection and the lookup --------------------------------
    const coll = stanzasIcm(rd(path.join(DEF_ICM, 'collections.conf'))).logserv_abapnet_rollup || [];
    pIcm('(d) collections', coll.indexOf('field.sap_client = string') !== -1, 'logserv_abapnet_rollup needs field.sap_client = string');
    const fl = (keyIcm(stanzasIcm(rd(path.join(DEF_ICM, 'transforms.conf'))).logserv_abapnet_rollup, 'fields_list') || '').split(/\s*,\s*/);
    pIcm('(d) transforms', fl.indexOf('sap_client') !== -1, `the logserv_abapnet_rollup fields_list lacks sap_client: ${fl.join(', ')}`);

    // ---- (e) readers ------------------------------------------------------
    const srcFiles = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.consistency-test\.ts$/.test(e.name)) srcFiles.push(p);
    });
    walk(HOME_ICM);
    // Code only: a comment may tell the history (lines starting //, /* or *).
    const code = (p) => rd(p).split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    const readers = srcFiles.filter((p) => /\bicm_status_code\b|metric="icmstat"/.test(code(p)));
    pIcm('(e) no reader', readers.length === 0,
        `still read icm_status_code / icmstat: ${readers.map((p) => path.relative(HOME_ICM, p)).join(', ')}`);
    const intent = rd(path.join(DEF_ICM, 'data/mcp/logserv_intent_map.json'));
    pIcm('(e) intent map', !/icm_status_code|icmstat/.test(intent), 'the AI catalog text names icm_status_code / icmstat');
    const abap = rd(path.join(HOME_ICM, 'dashboards/AbapSecurity.tsx'));
    const eh = rd(path.join(HOME_ICM, 'dashboards/EnvironmentHealth.tsx'));
    pIcm('(e) ABAP cached', abap.indexOf('const ICMSEV = `| inputlookup ${ROLL} where metric="icmsev" ${RANGE}`;') !== -1
        && abap.indexOf('const ICMCLIENT = `| inputlookup ${ROLL} where metric="icmclient" ${RANGE}`;') !== -1,
    'AbapSecurity reads the icmsev and icmclient metrics');
    const SID_CLIENT = '| eval sap_client=if(sap_sid="(none)", sap_client, sap_sid . " / " . sap_client) |';
    pIcm('(e) ABAP raw twins', abap.indexOf('icmSeverity: `${RAW_ICM} icm_severity=* | eval status_cat=icm_severity | timechart span=__LSV_SPAN__ count by status_cat | fillnull value=0`,') !== -1
        && abap.indexOf(`icmClientPie: \`\${RAW_ICM} sap_client=* | fillnull value="(none)" sap_sid ${SID_CLIENT} stats count by sap_client | sort -count\`,`) !== -1
        && abap.indexOf(`icmClientPie: \`\${ICMCLIENT} ${SID_CLIENT} stats sum(count) as count by sap_client | sort -count\`,`) !== -1
        && abap.indexOf('kpiIcmErrors: `${RAW_ICM} icm_is_error="true" | stats count`,') !== -1,
    'the sub-hour raw twins of the ICM panels count what the rollup arms count (the client pie by SID / client on both)');
    pIcm('(e) ICM Peers', !/dc\(\s*(eval\(if\()?icm_transaction_id/.test(abap) && /as Connections\b/.test(abap),
        'a connection line never carries a session ID: the ICM Peers table counts connections, not transactions');
    pIcm('(e) EH', eh.indexOf('const ICMSEV = `| inputlookup ${ROLL} where metric="icmsev" ${RANGE}`;') !== -1
        && eh.indexOf('\'`sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_severity=* \' +') !== -1,
    'Environment Health reads icmsev, and its raw twin icm_severity');
    // The AI Assistant is told to follow this lookup's SPL idioms (useAIAssistant primer); it is on the
    // AI lookup allow-list (splGuard), so its ICM row must not offer an HTTP status.
    const metaIcm = rd(path.join(ROOT_ICM, 'src/main/resources/splunk/lookups/logserv_sourcetype_metadata.csv')).split('\n')
        .filter((l) => l.startsWith('sap:abap:icm,'));
    pIcm('(e) sourcetype metadata', metaIcm.length === 1 && !/\bstatus\b|HTTP\/HTTPS access/.test(metaIcm[0])
        && /\bsap_client\b/.test(metaIcm[0]) && /\bicm_severity=ERROR\b/.test(metaIcm[0]),
    'the AI-facing sourcetype metadata row for sap:abap:icm must name sap_client / icm_severity and offer no HTTP status');
    if (badIcm === 0) {
        console.log(`check-diagnostics: 3icm ${nIcm} pins: sap:abap:icm has no HTTP status (the SAP client is sap_client), `
            + 'no CIM model, the icmsev / icmclient rollup arms with their sub-hour twins, ICM Peers counts connections');
    }
}

// --- 3span: chart time basis (build 377) -----------------------------------
//
// Session 152 found three things the gates did not cover. (A) Build 345
// tokenised Environment Health's per-day-average KPI (span=__LSV_SPAN__), so
// at Last 30 days it averaged 6-hour bins (462,432 against a true 1,849,729).
// A query that averages timechart bins is a per-BIN average: its span IS the
// unit and must stay 1d. KPI sparklines are daily by design. (B) About 40
// range-following charts were titled "Daily ..." while they drew 15m to 1d
// bins, and none printed its span (the CLAUDE.md "Dynamic timechart span"
// rule). (C) A sparkline's tooltip printed the browser's zone while its
// buckets follow the Splunk user's, and the beaconing sparklines (rows by UTC
// day) printed each UTC day under the previous local date west of UTC.
// Each pin names its query key or its panel; the denominators make a new
// chart, sparkline or averaging query fail until it is classified on purpose.
{
    const HOME_SP = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const DASH_SP = path.join(HOME_SP, 'dashboards');
    const srcSp = {};
    fs.readdirSync(DASH_SP).filter((f) => f.endsWith('.tsx')).forEach((f) => {
        srcSp[f] = fs.readFileSync(path.join(DASH_SP, f), 'utf8').replace(/\r\n/g, '\n');
    });
    const pSp = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3span ${label}: ${detail}`);
            failed = true;
        }
    };
    // A line counts when its text after the indentation starts with the prefix
    // (a '//' or ' * ' commented-out copy does not).
    const lineSp = (s, prefix) => s.split('\n').some((l) => l.trimStart().startsWith(prefix));
    const escSp = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const DAYWORD_SP = /\bdaily\b|\bper[- ]day\b|\/\s*day\b/i;
    // A string, template or double-quoted literal with no nested quote of its kind.
    const LIT_SP = '(?:\'[^\']*\'|`[^`]*`|"[^"]*")';

    // ---- (A) per-day averages and sparklines stay daily --------------------
    const eh = srcSp['EnvironmentHealth.tsx'];
    pSp('EH Events/Day (Avg) query', lineSp(eh, 'pipelineEventsPerDay: `| tstats count WHERE \\`sap_logserv_idx_macro\\` BY _time span=1d | timechart span=1d sum(count) as daily | stats avg(daily) as total |'),
        'the per-day-average KPI must bin by 1d in tstats AND timechart (the span is the unit)');
    pSp('EH Events/Day (Avg) card', /const pipelineEvents = useFirstRowField\(Q\.pipelineEventsPerDay, 'total'\);/.test(eh)
        && /label="Data Pipeline — Events\/Day \(Avg\)" value=\{pipelineEvents\.value\}/.test(eh),
        'the Events/Day (Avg) card must read Q.pipelineEventsPerDay');
    const avgSp = [];
    Object.entries(srcSp).forEach(([f, s]) => s.split('\n').forEach((l, i) => {
        if (!/^\s*(\/\/|\*)/.test(l) && /\btimechart\b[^`']*\|\s*stats\s+(avg|median|min|max|perc\d*|mean)\(/.test(l)) avgSp.push([f, i + 1, l]);
    }));
    pSp('per-day denominator', avgSp.length === 3, `expected 3 bin-averaging queries (EH 1, DPO 2), found ${avgSp.length}`);
    avgSp.forEach(([f, n, l]) => {
        const sp = (l.match(/span=([^\s|`]+)/g) || []).map((x) => x.slice(5));
        pSp(`${f}:${n} averages bins`, sp.length > 0 && sp.every((x) => x === '1d'), `span must be 1d everywhere (found ${sp.join(', ') || 'none'})`);
    });
    let sparkSp = 0;
    Object.entries(srcSp).forEach(([f, s]) => s.split('\n').forEach((l, i) => {
        if (!/^\s*spark[A-Za-z0-9]*:/.test(l)) return;
        sparkSp += 1;
        pSp(`${f}:${i + 1} sparkline daily`, /span=1d/.test(l) && !/__LSV_SPAN__|\$\{span\}/.test(l), 'KPI sparklines stay span=1d by design');
    }));
    pSp('sparkline denominator', sparkSp >= 84, `expected >= 84 spark* keys, found ${sparkSp}`);

    // ---- (B) every range-following chart prints its dispatched span --------
    // The TimeSeriesCharts that are not time charts (categorical x-axis).
    const EXEMPT_SP = new Set([
        'AbapSecurity.tsx|qSidInstance', 'HanaTrace.tsx|qComponentSeverity', 'HanaTrace.tsx|qSidInstance',
        'Linux.tsx|qSapAppActivity', 'HanaAudit.tsx|qAfterHours', 'WebApiPerformance.tsx|qTlsVersion',
    ]);
    let totalSp = 0;
    let exemptSp = 0;
    let checkedSp = 0;
    Object.entries(srcSp).forEach(([f, s]) => {
        const re = /<FramedPanel\b([\s\S]*?)<\/FramedPanel>/g;
        for (let m = re.exec(s); m; m = re.exec(s)) {
            const block = m[1];
            const ch = /<TimeSeriesChart\b[\s\S]*?\bquery=\{([^}]+)\}/.exec(block);
            if (!ch) continue;
            totalSp += 1;
            const q = ch[1].trim();
            if (EXEMPT_SP.has(`${f}|${q}`)) {
                exemptSp += 1;
                continue;
            }
            checkedSp += 1;
            const call = `spanSubtitle\\(${LIT_SP}\\s*,\\s*${escSp(q)}\\s*[,)]`;
            // Inline: subtitle={spanSubtitle(<literal>, <query>...)}. A memo
            // (subtitle={name}): a useMemo<string> whose EVERY return is one.
            const memo = /\bsubtitle=\{([A-Za-z_$][\w$]*)\}/.exec(block);
            let labelled;
            if (memo) {
                const mb = new RegExp(`const ${escSp(memo[1])} = useMemo<string>\\(\\(\\) => \\{([\\s\\S]*?)\\n\\s*\\}, \\[`).exec(s);
                const rets = mb ? mb[1].match(/\breturn\b[^;]*;/g) || [] : [];
                labelled = rets.length > 0 && rets.every((r) => new RegExp(`^return ${call}`).test(r));
            } else {
                labelled = new RegExp(`\\bsubtitle=\\{${call}`).test(block);
            }
            pSp(`${f} ${q} shows its span`, labelled,
                'a range-following chart subtitle must be spanSubtitle(<literal>, <its own query>[, <literal>])');
            const title = /\btitle="([^"]*)"/.exec(block);
            pSp(`${f} ${q} title`, !!title && !DAYWORD_SP.test(title[1]), `a range-following chart may not be titled daily: ${title ? title[1] : '(no literal title)'}`);
        }
    });
    pSp('chart denominator', totalSp === 63 && exemptSp === 6 && checkedSp === 57,
        `expected 63 time-series panels (6 exempt, 57 range-following), found ${totalSp} (${exemptSp} exempt, ${checkedSp})`);
    let callsSp = 0;
    Object.entries(srcSp).forEach(([f, s]) => {
        // Every literal handed to spanSubtitle (lead and tail) stays clear of "daily".
        const cre = new RegExp(`spanSubtitle\\((${LIT_SP})\\s*,\\s*[^,)]+(?:,\\s*(${LIT_SP}))?\\s*\\)`, 'g');
        for (let m = cre.exec(s); m; m = cre.exec(s)) {
            callsSp += 1;
            pSp(`${f} spanSubtitle text`, !DAYWORD_SP.test(m[1]) && !(m[2] && DAYWORD_SP.test(m[2])),
                `a span-labelled chart may not be called daily: ${m[0].slice(0, 160)}`);
        }
        pSp(`${f} raw span label`, !/— span \$\{span\}/.test(s), 'print the dispatched span (spanSubtitle), not the picked one');
        s.split('\n').forEach((l, i) => {
            if (/__LSV_SPAN__/.test(l) && /\bas\s+"[^"]*(day|daily)[^"]*"/i.test(l)) {
                pSp(`${f}:${i + 1} series name`, false, 'a range-following series may not be named per day');
            }
        });
    });
    // 57 panels; the DNS and DPO memo subtitles carry three calls each (one per branch).
    pSp('spanSubtitle calls', callsSp === 61, `expected 61 spanSubtitle calls with literal text (57 panels + 4 memo branches), found ${callsSp}`);
    ['DnsAnalytics.tsx', 'WebDispatcher.tsx'].forEach((f) => {
        pSp(`${f} clamps its rollup span`, !/span=\$\{span\}/.test(srcSp[f]) && (srcSp[f].match(/applySpanToken\(/g) || []).length >= 4,
            'the four span-parametrised charts must write span=${SPAN_TOKEN} and go through applySpanToken (rollup floor 1h)');
        // Their arms build SPL in a useMemo, outside mapCloudProviderQueries: each
        // must apply the Cloud picker itself and re-run on it. DNS Analytics' two
        // charts had ignored it.
        const depsSp = srcSp[f].match(/\[[^[\]\n]*\buseRawSrc\b[^[\]\n]*\]/g) || [];
        pSp(`${f} follows the Cloud picker`, (srcSp[f].match(/applySpanToken\(withCloudProvider\(/g) || []).length === 4
            && depsSp.length === 2 && depsSp.every((d) => /\bprovider\b/.test(d)),
            'each arm of the two span-parametrised charts must be applySpanToken(withCloudProvider(<spl>, provider), span), with provider in both memo dependency lists');
    });
    pSp('DNS client list follows the Cloud picker',
        /const clientListSearch = useHybridSearch<[^>]*>\(\{\s*cached: withCloudProvider\(`[^`]*`, provider\),\s*raw: withCloudProvider\(`[^`]*`, provider\),\s*\}\);/.test(srcSp['DnsAnalytics.tsx']),
        'the Clients picker must list the clients of the selected cloud (cached and raw through withCloudProvider)');
    const tcs = fs.readFileSync(path.join(HOME_SP, 'utils/timechartSpan.ts'), 'utf8');
    pSp('helper reads the dispatched span', /export const spanSubtitle = \(lead: string, spl: string, tail\?: string\): string => \{\s*const s = timechartSpanOf\(spl\);/.test(tcs),
        'spanSubtitle must read the span from the query it is given (timechartSpanOf), never take a picked span');

    // ---- (C) sparkline tooltips: the Splunk user's zone; beaconing by UTC day --
    const spk = fs.readFileSync(path.join(HOME_SP, 'components/Sparkline.tsx'), 'utf8');
    pSp('tooltip helpers imported', /import \{ formatBucketTime, utcDayLabel \} from '\.\.\/utils\/timechartSpan';/.test(spk),
        'Sparkline must format bucket times with utils/timechartSpan (formatBucketTime, utcDayLabel)');
    pSp('tooltip uses the bucket wall clock', /: times\s*\?\s*formatBucketTime\(times\[hoverIdx\]\)/.test(spk),
        'the tooltip time must be formatBucketTime(times[hoverIdx]) - the wall clock Splunk wrote into _time');
    pSp('no browser-zone dates', !/new Date\(/.test(spk), 'Sparkline may not build a Date: browser-zone formatting printed the wrong day');
    pSp('UTC-day labels', /utcDayLabel\(\(row as Record<string, unknown>\)\[utcDayField\], times\[i\]\)/.test(spk)
        && /timeLabels=\{timeLabels\}/.test(spk),
        'SparklineFromQuery must label a utcDayField point with utcDayLabel(<its day field>, <its bin time>)');
    // Every sparkline whose query reads a UTC-day rollup (day_ts) passes utcDayField.
    let dayTsSp = 0;
    Object.entries(srcSp).forEach(([f, s]) => {
        const qline = (k) => s.split('\n').find((l) => l.trimStart().startsWith(`${k}: \``)) || '';
        const sre = /<SparklineFromQuery query=\{Q\.(\w+)\}([^>]*)\/>/g;
        for (let m = sre.exec(s); m; m = sre.exec(s)) {
            const ql = qline(m[1]);
            if (!/day_ts|\$\{BEACON\}/.test(ql)) continue;
            dayTsSp += 1;
            pSp(`${f} ${m[1]} UTC-day tooltip`, /\butcDayField="day_ts"/.test(m[2]), 'a sparkline over a UTC-day rollup must pass utcDayField="day_ts"');
            pSp(`${f} ${m[1]} carries day_ts`, /\bby day_ts\b|\bmax\(day_ts\) as day_ts\b/.test(ql) && !/\|\s*fillnull value=0\s*`/.test(ql),
                'each point must carry its day_ts (stats by day_ts, or timechart max(day_ts) as day_ts with fillnull limited to the count)');
        }
    });
    pSp('UTC-day sparkline denominator', dayTsSp === 3, `expected 3 beaconing sparklines (EH, DNS, NP), found ${dayTsSp}`);
    [
        ['EnvironmentHealth.tsx', 'beaconing: `${BEACON} | stats sum(count) as count by day_ts | eval _time=day_ts | sort _time | eventstats sum(count) as total`'],
        ['DnsAnalytics.tsx', 'sparkBeaconing: `${BEACON} | eval _time=day_ts | timechart span=1d sum(count) as daily max(day_ts) as day_ts | fillnull value=0 daily`'],
        ['NetworkPerimeter.tsx', 'sparkBeacon: `${BEACON} | eval _time=day_ts | timechart span=1d sum(count) as daily max(day_ts) as day_ts | fillnull value=0 daily`'],
    ].forEach(([f, prefix]) => {
        pSp(`${f} beaconing rows by UTC day`, lineSp(srcSp[f], prefix), `expected a line starting ${prefix}`);
    });

    // ---- HANA Trace: the component guard and the hdbcons table -------------
    const ht = srcSp['HanaTrace.tsx'];
    pSp('HANA COMP_GUARD_RAW', lineSp(ht, 'const COMP_GUARD_RAW = \'len(hana_trace_component) > 3 AND hana_trace_component!="INFO" AND hana_trace_component!="of" AND hana_trace_component!="service:"\';'),
        'COMP_GUARD_RAW must keep the length rule and the three junk words');
    pSp('HANA COMP_GUARD', lineSp(ht, 'const COMP_GUARD = `hana_trace_component!="(none)" AND ${COMP_GUARD_RAW}`;'),
        'COMP_GUARD must be the "(none)" exclusion plus COMP_GUARD_RAW');
    let compSp = 0;
    ht.split('\n').forEach((l, i) => {
        const km = /^\s*(\w+): `/.exec(l);
        if (!km || km[1] === 'errorDetail' || !/hana_trace_component/.test(l)) return;
        compSp += 1;
        pSp(`HanaTrace.tsx:${i + 1} ${km[1]} guarded`, /\$\{COMP_GUARD(_RAW)?\}/.test(l),
            'every component read must apply COMP_GUARD (rollup) or COMP_GUARD_RAW (raw) - the KPI must count what the tables show');
    });
    pSp('HANA component reads', compSp === 9, `expected 9 component reads (5 cached, 4 raw), found ${compSp}`);
    const opsLines = ht.split('\n').filter((l) => /^\s*slowestOps: `/.test(l));
    pSp('hdbcons table queries', opsLines.length === 2 && opsLines.every((l) => /rename sap_sid AS SID, hana_op AS Command, events AS Runs \| table Command, SID, Runs, "Avg \(ms\)", "Max \(ms\)"`,$/.test(l)),
        'both slowestOps arms must return Command, SID, Runs, Avg (ms), Max (ms)');
    const colsSp = /const SLOWEST_OPS_COLS: ColumnDef\[\] = \[([\s\S]*?)\];/.exec(ht);
    const keysSp = colsSp ? (colsSp[1].match(/key: '([^']+)'/g) || []).map((x) => x.slice(6, -1)) : [];
    pSp('hdbcons table columns', keysSp.join('|') === 'Command|SID|Runs|Avg (ms)|Max (ms)', `SLOWEST_OPS_COLS keys must match the query columns (found ${keysSp.join(', ')})`);
    const opsPanel = /<FramedPanel search=\{slowestOps\} title="([^"]*)" subtitle="([^"]*)"/.exec(ht);
    const durPanel = /<FramedPanel title="([^"]*)" subtitle=\{spanSubtitle\('([^']*)', qDurationPercentiles/.exec(ht);
    pSp('hdbcons panels not called SQL', !!opsPanel && !!durPanel && ![opsPanel[1], opsPanel[2], durPanel[1], durPanel[2]].some((t) => /\bSQL\b/.test(t)),
        'the hdbcons command timings are not SQL operations (titles and subtitles)');

    console.log(`check-diagnostics: 3span ${avgSp.length} per-day averages and ${sparkSp} sparklines stay daily;`
        + ` ${checkedSp} range-following charts print their dispatched span (${exemptSp} categorical exempt);`
        + ` ${dayTsSp} UTC-day sparklines carry their day; ${compSp} HANA component reads guarded`);
}

// --- 3hana: HANA audit hosts and HANA trace severity on the dashboards (build 378) -
//
// h1: `host` on sap:hana:audit is the indexed HANA host (props.conf no longer
// aliases the client name into it); the client's host name is src_host. Every
// dashboard column must say which host it shows, and every listing must return
// the columns its table renders. i1: record files (hdbcons, SQL trace, loads,
// availability) carry no hana_trace_severity, so they are "(none)" in the
// rollup: By Severity and Component by Severity leave them out on BOTH arms
// while the totals count them, and the subtitle says so. The duration panels
// read only the ms-normalised field, never the raw value in mixed units.
{
    const HOME_3H = path.resolve(__dirname, '../src/main/webapp/pages/home');
    const CONF_3H = path.resolve(__dirname, '../src/main/resources/splunk/default');
    const rd3h = (rel) => fs.readFileSync(path.join(HOME_3H, rel), 'utf8').replace(/\r\n/g, '\n');
    const p3h = (label, ok, detail) => {
        if (!ok) {
            console.error(`check-diagnostics: 3hana ${label}: ${detail}`);
            failed = true;
        }
    };
    const ha = rd3h('dashboards/HanaAudit.tsx');
    const cc = rd3h('dashboards/ChangeConfig.tsx');
    const ht = rd3h('dashboards/HanaTrace.tsx');
    // The query line of key k (the first line starting `k: \``), '' if none.
    const qline3h = (s, k) => s.split('\n').find((l) => l.trimStart().startsWith(`${k}: \``)) || '';
    // ColumnDef keys / labels of `const NAME: ColumnDef[] = [...]`.
    const cols3h = (s, name) => {
        const m = new RegExp(`const ${name}: ColumnDef\\[\\] = \\[([\\s\\S]*?)\\];`).exec(s);
        return m ? [...m[1].matchAll(/\{ key: '([^']+)', label: '([^']+)'/g)].map((x) => [x[1], x[2]]) : [];
    };
    // The field list of a query's final `| table a, b, c` (up to the closing backtick).
    const table3h = (l) => {
        const m = /\| table ([^|`]+)`,?$/.exec(l);
        return m ? m[1].split(',').map((x) => x.trim()) : [];
    };

    // ---- h1, HANA Audit: the two raw listings ------------------------------
    [['highRiskEvents', 'HIGH_RISK_COLS'], ['afterHoursAdmin', 'AFTER_HOURS_COLS']].forEach(([k, c]) => {
        const fields = table3h(qline3h(ha, k));
        const cols = cols3h(ha, c);
        p3h(`HanaAudit ${k} returns HANA and client host`, fields.join(',').includes('host,src_host,client_ip'),
            `the listing must table host, src_host, client_ip (found: ${fields.join(', ') || 'no table'})`);
        p3h(`HanaAudit ${c} renders what ${k} returns`, cols.map((x) => x[0]).join('|') === fields.join('|'),
            `column keys ${cols.map((x) => x[0]).join(', ')} != query fields ${fields.join(', ')}`);
        const lab = Object.fromEntries(cols);
        p3h(`HanaAudit ${c} host labels`, lab.host === 'HANA Host' && lab.src_host === 'Client Host',
            `host must be labelled 'HANA Host' and src_host 'Client Host' (found ${lab.host}, ${lab.src_host})`);
    });
    const hc3h = cols3h(ha, 'HOST_COLS');
    p3h('HanaAudit failed-by-host column', hc3h.length > 0 && hc3h[0][0] === 'host' && hc3h[0][1] === 'HANA Host',
        'HOST_COLS must label host as HANA Host');
    p3h('HanaAudit failed-by-host panel', /<FramedPanel search=\{failedByHost\} title="Failed Operations by HANA Host"/.test(ha),
        'the panel grouped by host must say it is the HANA host');
    p3h('HanaAudit no plain Host label', !/label: 'Host'/.test(ha),
        'a HANA audit host column must say whether it is the HANA host or the client host');
    // The two drilldowns' Search-app tables show the client host too.
    p3h('HanaAudit drilldowns show the client host',
        (ha.match(/\| table _time action_type[^`]*\bhost src_host client_ip\b[^`]*`;/g) || []).length === 2,
        'goHighRiskRow and goAfterHoursRow must table host src_host client_ip');

    // ---- h1, Change & Configuration: the HANA change listing ----------------
    const hq = qline3h(cc, 'hana');
    p3h('ChangeConfig hana returns HANA and client host',
        /\| table Time, executing_user, target_user, action_category, action_type, status, host, src_host \| rename [^`]*\bhost as "HANA Host", src_host as "Client Host"`,$/.test(hq),
        'the HANA change listing must table host, src_host renamed "HANA Host", "Client Host"');
    p3h('ChangeConfig HANA_COLS', cols3h(cc, 'HANA_COLS').map((x) => x[0]).join('|')
        === 'Time|Operator|Target|Category|Action|Status|HANA Host|Client Host',
        'HANA_COLS must render the listing\'s renamed columns, ending HANA Host, Client Host');

    // ---- h1: no dashboard reads the client name under its extraction name ---
    const DASH_3H = path.join(HOME_3H, 'dashboards');
    // Code lines only: a comment may name the extraction to explain the change.
    const ahn = fs.readdirSync(DASH_3H).filter((f) => f.endsWith('.tsx')
        && fs.readFileSync(path.join(DASH_3H, f), 'utf8').split(/\r?\n/)
            .some((l) => !/^\s*(\/\/|\/?\*)/.test(l) && /\baudit_hostname\b/.test(l)));
    p3h('dashboards read src_host', ahn.length === 0,
        `read the HANA client host as src_host, not audit_hostname (${ahn.join(', ')})`);

    // ---- h1: props.conf produces what the dashboards read --------------------
    const props3h = fs.readFileSync(path.join(CONF_3H, 'props.conf'), 'utf8').replace(/\r\n/g, '\n');
    const st3h = /^\[sap:hana:audit\]\n([\s\S]*?)(?=^\[)/m.exec(props3h);
    const aud = st3h ? st3h[1] : '';
    p3h('props src_host', /^FIELDALIAS-[\w-]+\s*=\s*audit_hostname AS src_host\s*$/m.test(aud),
        '[sap:hana:audit] must alias audit_hostname AS src_host (the dashboards read src_host)');
    p3h('props host is indexed', !/^FIELDALIAS-[\w-]+\s*=.*\bAS(?:NEW)? host\b/im.test(aud) && !/^EVAL-host\s*=/m.test(aud),
        '[sap:hana:audit] may not rewrite host: host is the HANA host that wrote the record');

    // ---- i1, HANA Trace: record files carry no severity ----------------------
    // Cached arms exclude the "(none)" sentinel, raw arms require the field;
    // the totals filter on neither, so record files still count there.
    p3h('HanaTrace bySeverity cached', /\$\{MAIN\} \| search hana_trace_severity!="\(none\)" \|/.test(qline3h(ht, 'bySeverity')),
        'the cached By Severity arm must leave out "(none)" (record files)');
    const rawSev = ht.split('\n').filter((l) => /^\s*(bySeverity|componentSeverity): `\$\{HRAW\}/.test(l));
    p3h('HanaTrace severity raw arms', rawSev.length === 2 && rawSev.every((l) => /\bhana_trace_severity=\*/.test(l)),
        'both raw severity arms must require hana_trace_severity=* (record files have none)');
    p3h('HanaTrace componentSeverity cached', /AND hana_trace_severity!="\(none\)"/.test(qline3h(ht, 'componentSeverity')),
        'the cached Component by Severity arm must leave out "(none)"');
    const totals = ht.split('\n').filter((l) => /^\s*(kpiTotal|traceVolume): `/.test(l));
    p3h('HanaTrace totals count every event', totals.length === 4 && totals.every((l) => !/hana_trace_severity/.test(l)),
        'Total Trace Events and Trace Volume (both arms) may not filter on severity: record files count there');
    p3h('HanaTrace By Severity says so',
        /spanSubtitle\('Stacked volume by severity', qBySeverity, '[^']*record files[^']*no severity[^']*'\)/.test(ht),
        'the By Severity subtitle must say record files carry no severity');
    // Durations: only the ms-normalised field (the raw value mixes usec/msec/sec).
    p3h('HanaTrace durations in ms', !/\bhana_op_duration\b(?!_ms)|\bhana_op_duration_unit\b/.test(ht)
        && ht.split('\n').filter((l) => /^\s*(slowestOps|durationPercentiles): `\$\{HRAW\} hana_op_duration_ms=\*/.test(l)).length === 2,
        'the duration panels must read hana_op_duration_ms (normalised to ms), never hana_op_duration');

    console.log('check-diagnostics: 3hana HANA audit host columns say HANA Host / Client Host and match their queries;'
        + ' props keeps host indexed and aliases src_host; HANA trace record files stay out of the severity charts and in the totals');
}

// --- 3n: every consistency test on disk is actually wired ------------------
//
// The TESTS array and the async chain below are hand-maintained. Two files
// (hybridRouting, jailbreakPatterns) are wired NOWHERE and their headers still
// say "run with npx ts-node" -- exactly the rot session 091 found in the
// intent-map test, where a check nobody ran had been failing on a clean tree.
// Adding another hand-maintained entry inherits that, so enumerate from disk.
{
    const ASYNC_WIRED = [
        'diagEvidence.consistency-test',
        'diagReport.consistency-test',
        'diagPersistence.consistency-test',
        'diagIngestFacts.consistency-test',
        'diagPlatform.consistency-test',
        'historyCheck.consistency-test',
        'splGuard.consistency-test',
        'auditWriteHealth.consistency-test',
    ];
    // Deliberately unwired, with the reason. Anything else on disk fails.
    const KNOWN_UNWIRED = [
        // Pure-function routing table (session 085); its module has no build-
        // time coupling to shipped conf, and it predates this gate.
        'hybridRouting.consistency-test',
        // Prompt-injection pattern corpus (session 019); exercised through the
        // AI Assistant's own suite, not this one.
        'jailbreakPatterns.consistency-test',
    ];
    const onDisk = fs.readdirSync(UTILS)
        .filter((f) => f.endsWith('.consistency-test.ts'))
        .map((f) => f.replace(/\.ts$/, ''));
    const wired = TESTS.concat(ASYNC_WIRED).concat(KNOWN_UNWIRED);
    const orphans = onDisk.filter((f) => wired.indexOf(f) === -1);
    if (orphans.length > 0) {
        console.error(
            `check-diagnostics: ${orphans.length} consistency test(s) exist but are wired nowhere: ${orphans.join(', ')}`,
        );
        console.error('  (add to TESTS, to the async chain, or to KNOWN_UNWIRED with a reason)');
        failed = true;
    }
    const phantom = TESTS.concat(ASYNC_WIRED).filter((t) => onDisk.indexOf(t) === -1);
    if (phantom.length > 0) {
        console.error(`check-diagnostics: wired test(s) missing from disk: ${phantom.join(', ')}`);
        failed = true;
    }
    console.log(
        `check-diagnostics: ${onDisk.length} consistency tests on disk, ${onDisk.length - KNOWN_UNWIRED.length} wired, ${KNOWN_UNWIRED.length} deliberately not`,
    );
}

// --- 4: the async evidence-orchestration tests -----------------------------
//
// `diagEvidence.consistency-test` drives `gatherPanelEvidence` through a fake
// ProbeRunner, so it is async and exports `run()` instead of executing at load
// time like its siblings (whose process.exit interception would not survive a
// microtask boundary). The final verdict therefore lives in this chain.
// `diagPersistence.consistency-test` (build 311) chains after diagReport.
const evTest = loadTs(path.join(UTILS, 'diagEvidence.consistency-test'));
const reportTest = loadTs(path.join(UTILS, 'diagReport.consistency-test'));
const persistTest = loadTs(path.join(UTILS, 'diagPersistence.consistency-test'));
const ingestTest = loadTs(path.join(UTILS, 'diagIngestFacts.consistency-test'));
const platformTest = loadTs(path.join(UTILS, 'diagPlatform.consistency-test'));
// `historyCheck.consistency-test` (build 370) chains last and marks the chain done.
const historyTest = loadTs(path.join(UTILS, 'historyCheck.consistency-test'));
// `splGuard.consistency-test` (build 377): the ad-hoc SPL allow-list, the lexer
// and the search-parser check (its fail-closed paths are async).
const splGuardTest = loadTs(path.join(UTILS, 'splGuard.consistency-test'));
// `auditWriteHealth.consistency-test` (build 380, session 161): the AI Assistant's
// audit write health - every local audit write reports its outcome (Splunk
// refuses each one for a user without the edit_tcp capability), the chat
// panel's warning and the session-audit note, the page-unload write as a
// keepalive fetch with the CSRF headers, and the fallback audit index name
// (the shipped one, which the macro reads and the Data TA defines).
// Mutation-tested 41/41.
const auditHealthTest = loadTs(path.join(UTILS, 'auditWriteHealth.consistency-test'));
// An async suite whose promise never settles lets Node run out of work and exit
// 0 with neither OK nor FAILED printed - and `yarn build` carries on. A limiter
// that leaks a slot fails exactly that way (session 144), so an event loop that
// empties before the chain is done is a failure. 'beforeExit' never fires after
// process.exit(), so the chain's own exits are unaffected.
let asyncChainDone = false;
process.on('beforeExit', () => {
    if (asyncChainDone) return;
    console.error('check-diagnostics: an async consistency test never finished (a promise never settled)');
    console.error('\ncheck-diagnostics: FAILED');
    process.exit(1);
});
evTest
    .run()
    .then((evFailures) => {
        if (evFailures > 0) failed = true;
        return reportTest.run();
    })
    .then((reportFailures) => {
        if (reportFailures > 0) failed = true;
        return persistTest.run();
    })
    .then((persistFailures) => {
        if (persistFailures > 0) failed = true;
        return ingestTest.run();
    })
    .then((ingestFailures) => {
        if (ingestFailures > 0) failed = true;
        return platformTest.run();
    })
    .then((platformFailures) => {
        if (platformFailures > 0) failed = true;
        return historyTest.run();
    })
    .then((historyFailures) => {
        if (historyFailures > 0) failed = true;
        return splGuardTest.run();
    })
    .then((splGuardFailures) => {
        if (splGuardFailures > 0) failed = true;
        return auditHealthTest.run();
    })
    .then((auditHealthFailures) => {
        if (auditHealthFailures > 0) failed = true;
        asyncChainDone = true;
        if (failed) {
            console.error('\ncheck-diagnostics: FAILED');
            process.exit(1);
        }
        console.log('check-diagnostics: OK');
    })
    .catch((e) => {
        console.error('check-diagnostics: an async consistency test threw:');
        console.error(e && e.stack ? e.stack : e);
        console.error('\ncheck-diagnostics: FAILED');
        process.exit(1);
    });
