/**
 * diagPersistence consistency test — pins the Data Doctor report persistence
 * layer (build 311 / session 096, design §13.5 + §13.8a).
 *
 * What it pins: the record build (epoch-seconds timestamp, kind→scope,
 * appendix strip/restore round trip), the truncation guard, the per-kind
 * summaries, the write:[*] sanitize-on-read paths (key pattern, future-dated
 * junk, oversize payloads, renderer-shape validation), the filename allowlist,
 * and the KV list request's load-bearing params — `sort=generated_at:-1` (the
 * colon form; the dash form silently returns ASCENDING, session 094) and the
 * `fields` exclusion of model_json. Async (fake-fetch-driven) — exports
 * `run()`, awaited by `bin/check-diagnostics.js`; never calls process.exit.
 */

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

const persistMod = require('./diagPersistence') as any;
const reportMod = require('./diagReport') as any;
const envMod = require('./diagEnvironment') as any;

const proc = process as unknown as { stderr: { write(s: string): void } };

const {
    DIAG_REPORT_FIELDS,
    MAX_MODEL_JSON_CHARS,
    RETENTION_MAX_ROWS,
    buildReportRecord,
    summarizeModel,
    stripAppendixForStorage,
    restoreAppendix,
    looksLikeReportModel,
    safeFilenameBase,
    parseListRow,
    persistReport,
    listReports,
    fetchReportModel,
} = persistMod;

const { jsonAppendixSection } = reportMod;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const META = {
    appVersion: '0.1.1',
    appBuild: '311',
    appBuildDate: '2026-08-08',
    templatesOnly: false,
    username: 'tester',
};

const NOW = 1780000000; // fixed epoch seconds for determinism

/** A well-formed model of the given kind, shaped like the real builders'. */
const makeModel = (kind: string, over?: Record<string, unknown>): any => {
    const json: Record<string, unknown> = { schema: 'logserv.diag/1', kind };
    if (kind === 'panel') {
        json.diagnosis = {
            top: { headline: 'The index has no events in this range.', confidence: 'confirmed' },
            all: [],
            incomplete: false,
        };
    }
    if (kind === 'dashboard') {
        json.sweep = { entries: [{}, {}, {}], diagnosedCount: 2, budgetExhausted: false };
    }
    if (kind === 'environment') {
        json.environment = {
            rollups: [
                { status: 'ok' },
                { status: 'ok' },
                { status: 'stale' },
                { status: 'not-checked' },
            ],
        };
    }
    return {
        title: 'LogServ Data Doctor Report',
        scopeLine: `${kind} diagnosis — test`,
        reportId: 'LSV-TESTID1-AB12',
        generatedAtLocal: '2026-08-08 12:00 (local)',
        generatedAtUtc: '2026-08-08 12:00 UTC',
        banner: reportMod.dataBanner(false),
        meta: { ...META },
        sections: [
            { heading: 'Verdict', blocks: [{ kind: 'paragraphs', text: ['x'] }] },
            jsonAppendixSection(json),
        ],
        json,
        filenameBase: 'logserv-diagnostic-test-2026-08-08-1200',
        ...(over || {}),
    };
};

interface FakeCall {
    url: string;
    init?: { method?: string; headers?: Record<string, string>; body?: string };
}

const makeFetch = (
    responder: (url: string, init?: FakeCall['init']) => { ok: boolean; status: number; body: unknown },
): { calls: FakeCall[]; fetch: any } => {
    const calls: FakeCall[] = [];
    const fetchImpl = (url: string, init?: FakeCall['init']): Promise<any> => {
        calls.push({ url, init });
        const r = responder(url, init);
        return Promise.resolve({
            ok: r.ok,
            status: r.status,
            json: (): Promise<unknown> => Promise.resolve(r.body),
        });
    };
    return { calls, fetch: fetchImpl };
};

// ---------------------------------------------------------------------------

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, okC: boolean, detail: string): void => {
        checks += 1;
        if (!okC) {
            failures += 1;
            proc.stderr.write(`FAIL: ${label}: ${detail}\n`);
        }
    };

    // --- size-product bound (§13.8a correction 5) --------------------------
    check(
        'caps.retentionRoundTripBound',
        MAX_MODEL_JSON_CHARS * RETENTION_MAX_ROWS <= 40000000,
        `${MAX_MODEL_JSON_CHARS} x ${RETENTION_MAX_ROWS} exceeds the 40 MB nightly round-trip bound`,
    );

    // --- record build ------------------------------------------------------
    const envModel = makeModel('environment');
    const rec = buildReportRecord(envModel, NOW);
    check('record.key', rec._key === 'LSV-TESTID1-AB12', `got ${rec._key}`);
    check('record.reportId', rec.report_id === 'LSV-TESTID1-AB12', `got ${rec.report_id}`);
    check('record.epochSeconds', rec.generated_at === NOW, `got ${rec.generated_at}`);
    check(
        'record.isoMatchesEpoch',
        rec.generated_at_iso === new Date(NOW * 1000).toISOString(),
        `got ${rec.generated_at_iso}`,
    );
    check('record.scopeFromKind', rec.scope === 'environment', `got ${rec.scope}`);
    check('record.username', rec.username === 'tester', `got ${rec.username}`);
    check('record.appBuild', rec.app_build === '311', `got ${rec.app_build}`);
    check('record.notTruncated', rec.truncated === 0 && rec.model_json.length > 0, 'unexpected truncation');
    check(
        'record.fieldSet',
        Object.keys(rec).sort().join(',') === DIAG_REPORT_FIELDS.slice().sort().join(','),
        `record keys ${Object.keys(rec).sort().join(',')} != DIAG_REPORT_FIELDS`,
    );

    // The stored model has NO appendix section; restoreAppendix reproduces it
    // byte-identically to the builders' own.
    const storedModel = JSON.parse(rec.model_json);
    const hasAppendix = (m: any): boolean => {
        const heading = jsonAppendixSection({}).heading;
        for (let i = 0; i < m.sections.length; i += 1) {
            if (m.sections[i].heading === heading) return true;
        }
        return false;
    };
    check('record.appendixStripped', !hasAppendix(storedModel), 'appendix section survived storage');
    const restored = restoreAppendix(storedModel);
    check('record.appendixRestored', hasAppendix(restored), 'restoreAppendix added nothing');
    const expectedAppendix = jsonAppendixSection(envModel.json);
    const restoredAppendix = restored.sections[restored.sections.length - 1];
    check(
        'record.appendixByteIdentical',
        JSON.stringify(restoredAppendix) === JSON.stringify(expectedAppendix),
        'restored appendix differs from the builder’s',
    );
    check(
        'record.restoreIdempotent',
        restoreAppendix(restored) === restored,
        'restoreAppendix must be a no-op when the appendix is present',
    );
    check(
        'record.stripPure',
        hasAppendix(envModel),
        'stripAppendixForStorage must not mutate its input',
    );

    // --- truncation guard --------------------------------------------------
    const bigModel = makeModel('panel');
    bigModel.sections = [
        { heading: 'Big', blocks: [{ kind: 'mono', text: 'x'.repeat(MAX_MODEL_JSON_CHARS + 10) }] },
    ];
    const bigRec = buildReportRecord(bigModel, NOW);
    check('truncate.flag', bigRec.truncated === 1, `got ${bigRec.truncated}`);
    check('truncate.emptyPayload', bigRec.model_json === '', 'oversize model_json was stored');
    check(
        'truncate.stillListable',
        bigRec.scope === 'panel' && bigRec.verdict_summary.length > 0,
        'truncated record lost its summary fields',
    );

    // --- summaries ---------------------------------------------------------
    check(
        'summary.panel',
        summarizeModel(makeModel('panel')) ===
            'The index has no events in this range. (confirmed)',
        `got ${summarizeModel(makeModel('panel'))}`,
    );
    check(
        'summary.dashboard',
        summarizeModel(makeModel('dashboard')) === '2 of 3 panel(s) diagnosed',
        `got ${summarizeModel(makeModel('dashboard'))}`,
    );
    check(
        'summary.environment',
        summarizeModel(makeModel('environment')) === 'Rollups: ok 2 / stale 1 / not-checked 1',
        `got ${summarizeModel(makeModel('environment'))}`,
    );
    check(
        'summary.unknownKindFallsBack',
        summarizeModel(makeModel('mystery')) === 'mystery diagnosis — test',
        `got ${summarizeModel(makeModel('mystery'))}`,
    );

    // --- persistReport -----------------------------------------------------
    {
        const { calls, fetch } = makeFetch(() => ({ ok: true, status: 201, body: {} }));
        const r = await persistReport(makeModel('environment'), fetch);
        check('persist.ok', r.ok === true, r.reason);
        check('persist.oneCall', calls.length === 1, `made ${calls.length} calls`);
        check(
            'persist.collectionPost',
            calls[0].url.indexOf('/storage/collections/data/logserv_diag_reports') !== -1 &&
                calls[0].init !== undefined &&
                calls[0].init.method === 'POST',
            `got ${calls[0].url}`,
        );
        const body = JSON.parse((calls[0].init && calls[0].init.body) || '{}');
        check('persist.bodyIsRecord', body._key === 'LSV-TESTID1-AB12', 'POST body is not the record');
    }
    {
        const { fetch } = makeFetch(() => ({ ok: false, status: 409, body: {} }));
        const r = await persistReport(makeModel('environment'), fetch);
        check('persist.httpFailureReported', r.ok === false && r.reason.indexOf('409') !== -1, r.reason);
    }
    {
        const { calls, fetch } = makeFetch(() => ({ ok: true, status: 200, body: {} }));
        const bad = makeModel('environment', { reportId: '../evil' });
        const r = await persistReport(bad, fetch);
        check('persist.badIdRejected', r.ok === false, 'accepted a non-LSV report id');
        check('persist.badIdNoDispatch', calls.length === 0, 'dispatched despite a bad id');
    }
    {
        const fetchThrows = (): Promise<never> => Promise.reject(new Error('network down'));
        const r = await persistReport(makeModel('environment'), fetchThrows as any);
        check('persist.neverThrows', r.ok === false && r.reason.indexOf('network down') !== -1, r.reason);
    }

    // --- listReports -------------------------------------------------------
    {
        const nowSec = Math.floor(Date.now() / 1000);
        const goodRow = {
            _key: 'LSV-AAA111-BB22',
            generated_at: nowSec - 60,
            generated_at_iso: 'iso',
            username: 'u',
            scope: 'panel',
            scope_label: 'lbl',
            verdict_summary: 'sum',
            app_build: '311',
            truncated: 0,
        };
        const rows = [
            goodRow,
            { ...goodRow, _key: 'not-a-report-id' }, // junk key → skipped
            { ...goodRow, _key: 'LSV-FUTURE1-XX99', generated_at: nowSec + 7 * 86400 }, // future junk
            { ...goodRow, _key: 'LSV-NONUM11-XX99', generated_at: 'soon' }, // non-numeric
            null, // malformed row
            { ...goodRow, _key: 'LSV-TRUNC11-XX99', truncated: 1 },
        ];
        const { calls, fetch } = makeFetch(() => ({ ok: true, status: 200, body: rows }));
        const out = await listReports(50, fetch);
        check('list.notNull', out !== null, 'transport-ok list returned null');
        check(
            'list.sanitizeOnRead',
            out !== null && out.length === 2,
            `kept ${out === null ? 'null' : out.length} of 6 rows (want 2)`,
        );
        check(
            'list.truncatedFlag',
            out !== null && out[1] !== undefined && out[1].truncated === true,
            'truncated row flag lost',
        );
        const url = calls[0].url;
        check(
            'list.sortColonForm',
            url.indexOf('sort=generated_at:-1') !== -1,
            `sort param wrong/absent in ${url}`,
        );
        check(
            'list.fieldsExcludeModelJson',
            url.indexOf('fields=') !== -1 && url.indexOf('model_json') === -1,
            `model_json leaked into the list request: ${url}`,
        );
        check(
            'list.fieldsCarryListColumns',
            decodeURIComponent(url).indexOf('report_id') !== -1 &&
                decodeURIComponent(url).indexOf('verdict_summary') !== -1,
            `list fields incomplete: ${url}`,
        );
    }
    {
        const { fetch } = makeFetch(() => ({ ok: false, status: 503, body: [] }));
        const out = await listReports(50, fetch);
        check('list.transportFailureIsNull', out === null, 'HTTP 503 did not return null');
    }

    // --- fetchReportModel --------------------------------------------------
    const servedRecord = buildReportRecord(makeModel('environment'), NOW);
    const serveRecord = (record: unknown): { ok: boolean; status: number; body: unknown } => ({
        ok: true,
        status: 200,
        body: record,
    });
    {
        const { calls, fetch } = makeFetch(() => serveRecord(servedRecord));
        const model = await fetchReportModel('LSV-TESTID1-AB12', fetch);
        check('fetch.roundTrip', model !== null, 'valid stored model rejected');
        check(
            'fetch.appendixRestored',
            model !== null && hasAppendix(model),
            'fetched model lacks the appendix section',
        );
        check(
            'fetch.keyInUrl',
            calls[0].url.indexOf('LSV-TESTID1-AB12') !== -1,
            `got ${calls[0].url}`,
        );
        check(
            'fetch.filenameSane',
            model !== null && /^[A-Za-z0-9._-]+$/.test(model.filenameBase),
            model === null ? 'null' : model.filenameBase,
        );
    }
    {
        const { calls, fetch } = makeFetch(() => serveRecord(servedRecord));
        const model = await fetchReportModel('../../etc/passwd', fetch);
        check('fetch.badKeyRejected', model === null, 'accepted a non-LSV key');
        check('fetch.badKeyNoDispatch', calls.length === 0, 'dispatched despite a bad key');
    }
    {
        const over = { ...servedRecord, model_json: `"${'x'.repeat(MAX_MODEL_JSON_CHARS + 10)}"` };
        const { fetch } = makeFetch(() => serveRecord(over));
        check(
            'fetch.oversizeRejected',
            (await fetchReportModel('LSV-TESTID1-AB12', fetch)) === null,
            'a hand-POSTed oversize payload reached the renderer',
        );
    }
    {
        const bad = { ...servedRecord, model_json: '{not json' };
        const { fetch } = makeFetch(() => serveRecord(bad));
        check(
            'fetch.nonJsonRejected',
            (await fetchReportModel('LSV-TESTID1-AB12', fetch)) === null,
            'non-JSON payload accepted',
        );
    }
    {
        // Shape that passes a naive title/sections check but would make
        // renderReportPdf throw (missing meta) — must be rejected (L3-F2).
        const noMeta = makeModel('environment');
        delete noMeta.meta;
        const rec2 = {
            ...servedRecord,
            model_json: JSON.stringify(stripAppendixForStorage(noMeta)),
        };
        const { fetch } = makeFetch(() => serveRecord(rec2));
        check(
            'fetch.missingMetaRejected',
            (await fetchReportModel('LSV-TESTID1-AB12', fetch)) === null,
            'a model without meta reached the renderer',
        );
    }
    {
        const empty = { ...servedRecord, model_json: '' };
        const { fetch } = makeFetch(() => serveRecord(empty));
        check(
            'fetch.truncatedRowRejected',
            (await fetchReportModel('LSV-TESTID1-AB12', fetch)) === null,
            'a truncated row (empty model_json) was accepted',
        );
    }

    // --- looksLikeReportModel edges ----------------------------------------
    check('shape.acceptsReal', looksLikeReportModel(makeModel('panel')), 'real model rejected');
    check('shape.rejectsNull', !looksLikeReportModel(null), 'null accepted');
    check(
        'shape.rejectsBadSections',
        !looksLikeReportModel(makeModel('panel', { sections: [{ heading: 7, blocks: [] }] })),
        'section with a non-string heading accepted',
    );
    check(
        'shape.rejectsNonBooleanTemplatesOnly',
        !looksLikeReportModel(
            makeModel('panel', { meta: { ...META, templatesOnly: 'no' } }),
        ),
        'meta.templatesOnly string accepted',
    );
    check(
        'shape.rejectsArrayJson',
        !looksLikeReportModel(makeModel('panel', { json: [] })),
        'array json accepted',
    );

    // --- safeFilenameBase --------------------------------------------------
    const cleaned = safeFilenameBase('a b/c\\d<e>.pdf');
    check(
        'filename.allowlist',
        /^[A-Za-z0-9._-]+$/.test(cleaned) &&
            cleaned.indexOf('/') === -1 &&
            cleaned.indexOf('\\') === -1,
        `got ${cleaned}`,
    );
    check(
        'filename.emptyFallback',
        safeFilenameBase('///') === 'logserv-diagnostic-report',
        `got ${safeFilenameBase('///')}`,
    );
    check(
        'filename.lengthCap',
        safeFilenameBase('x'.repeat(300)).length <= 80,
        'length cap not applied',
    );

    // --- parseListRow direct edges -----------------------------------------
    const nowSec2 = Math.floor(Date.now() / 1000);
    check(
        'row.stringNumberCoerced',
        parseListRow(
            {
                _key: 'LSV-COERCE1-AA11',
                generated_at: String(nowSec2 - 5),
                truncated: '1',
            },
            nowSec2,
        ) !== null,
        'KV string-number generated_at rejected',
    );
    check('row.zeroEpochRejected', parseListRow({ _key: 'LSV-ZERO111-AA11', generated_at: 0 }, nowSec2) === null, 'epoch 0 accepted');

    // --- rollup History verdicts (diagEnvironment; design §13.8a correction 4)
    //
    // The #/diagnostics page's History column must agree with the Settings
    // panel's completeness predicate on well-formed rows AND refuse to guess
    // on the malformed shapes (write:[*] junk, mid-write races) — pinned here
    // because these are the cases where the naive kvExtent mapping and the
    // panel's oneshot predicate DISAGREE.
    {
        const { classifyRollupHistory, combineRollupHistory, COMPLETE_SECONDS } = envMod;
        const now = NOW;
        const old = now - COMPLETE_SECONDS - 86400; // reaches back past the bar
        const recent = now - 5 * 86400; // not far enough back
        check(
            'history.notProbedIsUnknown',
            classifyRollupHistory(false, old, now - 3600, now) === 'unknown',
            'a failed probe classified',
        );
        check(
            'history.bothNullIsEmpty',
            classifyRollupHistory(true, null, null, now) === 'empty',
            'empty collection not detected',
        );
        check(
            'history.completeWhenOldEnough',
            classifyRollupHistory(true, old, now - 3600, now) === 'complete',
            'complete not detected',
        );
        check(
            'history.incompleteWhenShallow',
            classifyRollupHistory(true, recent, now - 3600, now) === 'incomplete',
            'shallow history read as complete',
        );
        // Shape (i): a junk row with bucket_ts = 0 must NOT read as ancient
        // history (the Settings panel's m > 0 guard).
        check(
            'history.zeroEpochNotComplete',
            classifyRollupHistory(true, 0, now - 3600, now) === 'incomplete',
            'bucket_ts=0 certified complete',
        );
        // Shapes (ii)/(iii): exactly one extent null = probe-degenerate
        // (missing-field row sorts first ascending, or a mid-write race with
        // the nightly retention overwrite) — never a verdict.
        check(
            'history.oldestNullIsUnknown',
            classifyRollupHistory(true, null, now - 3600, now) === 'unknown',
            'asymmetric null (oldest) classified',
        );
        check(
            'history.newestNullIsUnknown',
            classifyRollupHistory(true, old, null, now) === 'unknown',
            'asymmetric null (newest) classified',
        );
        // Per-rollup precedence: unknown DOMINATES (never certify complete
        // from a set containing an unchecked collection — L1-F3's mutation).
        check(
            'history.unknownDominatesComplete',
            combineRollupHistory(['complete', 'unknown']) === 'unknown',
            'a rollup with an unchecked collection was certified',
        );
        check(
            'history.emptyPullsIncomplete',
            combineRollupHistory(['complete', 'empty']) === 'incomplete',
            'an empty collection did not pull the rollup down',
        );
        check(
            'history.allCompleteIsComplete',
            combineRollupHistory(['complete', 'complete']) === 'complete',
            'all-complete not combined to complete',
        );
        check(
            'history.emptySetIsUnknown',
            combineRollupHistory([]) === 'unknown',
            'no collections read as a verdict',
        );
    }

    /* SS16.8a-25/26 - sample-bearing models are never stored, and the banner
     * is the exact derivation of the samples state. */
    {
        const withSamples = makeModel('panel', {
            banner: reportMod.dataBanner(true),
            json: {
                schema: 'logserv.diag/1',
                kind: 'panel',
                rawSamples: { events: [], fromWindow: true, excludedFilters: [], error: 'x' },
            },
        });
        const pf = makeFetch(() => ({ ok: true, status: 201, body: {} }));
        const pres = await persistMod.persistReport(withSamples, pf.fetch);
        check(
            's16.persist.refusesSamples',
            pres.ok === false && pf.calls.length === 0,
            'a sample-bearing model reached the collection',
        );
        check(
            's16.shape.rejectsSamples',
            persistMod.looksLikeReportModel(withSamples) === false,
            'shape gate accepted a sample-bearing model',
        );
        const wrongBanner = makeModel('panel', { banner: 'It contains no raw log events.' });
        check(
            's16.shape.bannerDerivation',
            persistMod.looksLikeReportModel(wrongBanner) === false,
            'shape gate accepted a non-derived banner',
        );
        check(
            's16.shape.acceptsDerivedBanner',
            persistMod.looksLikeReportModel(makeModel('panel')) === true,
            'the samples-free derived banner was rejected',
        );
        /* §20.8a-4 — a report STORED BY A PRIOR BUILD carries that build's
         * banner verbatim; without the legacy list, changing the banner
         * wording silently breaks re-download of the entire stored history
         * (kills mutation f: dropping LEGACY_DATA_BANNERS from the check). */
        const legacyList = reportMod.LEGACY_DATA_BANNERS as string[];
        check(
            's20.shape.legacyListPresent',
            Array.isArray(legacyList) && legacyList.length >= 1,
            'LEGACY_DATA_BANNERS missing',
        );
        const legacyModel = makeModel('panel', { banner: legacyList[0] });
        check(
            's20.shape.acceptsLegacyBanner',
            persistMod.looksLikeReportModel(legacyModel) === true,
            'a pre-§20 stored report must still pass the shape check',
        );
        check(
            's20.shape.legacyIsNotCurrent',
            legacyList.indexOf(reportMod.dataBanner(false)) === -1,
            'the legacy list must hold PRIOR forms only — the current banner has its own path',
        );
    }

    if (failures > 0) {
        proc.stderr.write(
            `\ndiagPersistence consistency test: ${failures} failure(s) of ${checks} checks\n`,
        );
    } else {
        console.log(`diagPersistence consistency test: ${checks} checks OK`);
    }
    return failures;
};
