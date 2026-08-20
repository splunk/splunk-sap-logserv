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
//     inverse expects fnmatch.translate-generated fragments inside the
//     `"clz_dir"` lookahead shape from filter_utils.py. A writer-mechanism
//     change must fail HERE, not in a customer's mis-parsed paste.
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
    const UTILS_PATH = path.resolve(
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
        if (utilsSrc.indexOf('fnmatch_translate') === -1 || utilsSrc.indexOf('"clz_dir"') === -1) {
            s19fail(
                'the Data TA filter generator no longer uses fnmatch.translate inside the "clz_dir" lookahead shape — the §19.8a-6 transforms inverse must be re-verified',
            );
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
// ITS twin re-derive the identical expression TWELVE times (4 edge types x
// edge_op/edge_perf/edge_err) as those metrics' `scope`. Nothing but this check
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

        // (a) shape: one shared derivation per edges stanza, twelve per detail
        //     stanza. A count change means an edge type was added on one side.
        edgeIds.forEach((ids, i) => {
            if (ids.length !== 1) {
                console.error(
                    `check-diagnostics: [${EDGE_STANZAS[i]}] has ${ids.length} edge-id derivations, expected 1`,
                );
                failed = true;
            }
        });
        detailIds.forEach((ids, i) => {
            if (ids.length !== 12) {
                console.error(
                    `check-diagnostics: [${DETAIL_STANZAS[i]}] has ${ids.length} edge-scope derivations, expected 12 (4 types x 3 metrics)`,
                );
                failed = true;
            }
        });

        // (b) the type SETS must agree: whatever `eval type="..."` the edges
        //     stanza emits is exactly what the detail arms may scope by.
        const evalTypes = (body) => {
            const out = new Set();
            const re = /\btype\s*=\s*"(http|rfc|hana_audit|hana_tenant)"/g;
            let m;
            while ((m = re.exec(body)) !== null) out.add(m[1]);
            return Array.from(out).sort();
        };
        const edgeTypes = evalTypes(bodyOf(EDGE_STANZAS[0]));
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
                `check-diagnostics: topology edge-id contract derived from conf (substr len ${N}, types ${edgeTypes.join('/')}, 12 detail arms x2)`,
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
        const body = nonComment(saved, n);
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
        const body = nonComment(saved, n);
        p325(`[${n}] lost the metric-scoped RFC row key`,
            body.indexOf(KEY_FORM) !== -1,
            `expected exactly: ${KEY_FORM} — the fallback must stay byte-identical to the `
            + 'legacy key and the rfc branch must include the coalesced local_ip');
        p325(`[${n}] no longer projects local_ip`,
            body.indexOf('| fields _key, id, source_id, target_id, type, direction, local_ip, bucket_ts,') !== -1,
            'local_ip is dropped before outputlookup, so the By-app-server split has no addresses');
        p325(`[${n}] rfc arm no longer groups by local_ip`,
            body.indexOf('by sap_sid, peer_ip, local_ip, _time') !== -1,
            'without the group-by the projected local_ip is not the per-app-server dimension');
    });

    // (c) the instances measure, end to end -------------------------------
    const DETAIL = ['logserv_topology_detail_aggregate', 'logserv_topology_detail_backfill'];
    DETAIL.forEach((n) => {
        const body = nonComment(saved, n);
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
                if (adjMin < baseMin - 1e-6) {
                    console.error(
                        `check-diagnostics: ${labels[i]} adjacent wedges fall below the base palette's `
                        + `separation (${adjMin.toFixed(1)} < ${baseMin.toFixed(1)})`,
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
