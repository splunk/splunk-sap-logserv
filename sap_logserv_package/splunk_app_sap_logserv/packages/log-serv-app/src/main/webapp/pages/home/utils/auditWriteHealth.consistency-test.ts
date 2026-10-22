/**
 * Build-time consistency test for the AI Assistant's audit write health
 * (components/ai/audit/auditWriter.ts and the chat panel's warning).
 *
 * The App writes audit events through Splunk's receivers/simple endpoint as
 * the signed-in user, which needs the edit_tcp or the edit_log_alert_event
 * capability; of Splunk Enterprise's default roles admin and power hold one
 * and user neither, so for a user-only user every write is refused (HTTP
 * 403, seen on Splunk 9.4.3). The writer stays fail-open (a refused write is dropped and the
 * assistant keeps working); what this test holds is that the refusal is no
 * longer silent, that the page-unload write can succeed at all, and that the
 * App's fallback index name is the real one.
 *
 * What it pins:
 *  - A. THE CHANNEL. Every local write reports {ok, status, when, events} to
 *    the onAuditWriteResult listeners: a flush refused with HTTP 403, a flush
 *    that throws (status null), an accepted flush, a postOneOff refused or
 *    throwing; each keeps its console line; a listener that throws breaks
 *    nothing; unsubscribing stops delivery; flush and postOneOff resolve.
 *  - B. THE PROBLEM STATE. nextAuditWriteProblem starts on a failure, extends
 *    on the next (latest status, first failure's time, events added up) and
 *    clears on a success; AIAssistantProvider subscribes with it in an effect
 *    (whose cleanup unsubscribes) and exposes auditWriteProblem.
 *  - C. THE WORDS. describeAuditWriteProblem: HTTP 403 and 401 name the
 *    edit_log_alert_event and edit_tcp capabilities and Splunk's default user
 *    role, never power (which holds edit_log_alert_event); other statuses and
 *    no response say what happened and blame no capability;
 *    no version strings. The chat panel renders the warning in an alert
 *    region under the privacy banner, and the "Audit this session" list
 *    carries the note.
 *  - D. THE UNLOAD WRITE. No Beacon API left in the writer (it could not set
 *    the CSRF header, so Splunk Web refused every unload write); pagehide and
 *    beforeunload still trigger it; it is a keepalive fetch, POST, same-origin
 *    credentials, the CSRF form key read from the cookie, the XMLHttpRequest
 *    and JSON content-type headers, to the receivers/simple URL; its outcome
 *    is reported; a body over the keepalive limit sends the newest events
 *    that fit (in order, counted in UTF-8 bytes, as many as fit) and says how
 *    many it dropped; one event over the limit sends nothing.
 *  - E. THE INDEX NAME. The shipped audit_index_name (ai_assistant_settings.
 *    conf) is the index the audit macro reads and the Data TA's indexes.conf
 *    defines, and every default the App falls back to is that name (the
 *    writer's, aiConfigApi's - also for an empty or missing stored value -
 *    and AIAssistantConfig's); the audit index's old, pre-rename name is not
 *    left quoted anywhere in the web source.
 *  - F. ONE-OFF EVENTS (build 392). postOneOff sends an event where the
 *    settings in place when it is posted say: forwarded when forwarding was
 *    on then (though switched off while its local write was in flight), with
 *    the token in place then; not forwarded when it was off then (though
 *    switched on); a failed forward's record goes to the event's index
 *    (though the index was renamed meanwhile). Both are restored afterwards.
 *
 * Async (the writer's outcomes are), so it exports `run()` for the async
 * chain of bin/check-diagnostics.js.
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void } };

const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const aw = require('../components/ai/audit/auditWriter');
const aiApi = require('./aiConfigApi');
const aiCfg = require('../state/AIAssistantConfig');

const HOME = path.resolve(__dirname, '..');
const DEF = path.resolve(__dirname, '../../../../resources/splunk/default');
const DATA_TA_INDEXES = path.resolve(DEF, '../../../../../../../../splunk_ta_sap_logserv/package/default/indexes.conf');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** The audit index's name before it became logserv_ai_assistant_audit. Built
 *  from parts so this file never matches its own scan. */
const OLD_INDEX = ['ai', 'assistant', 'audit'].join('_');

const RECEIVERS = '/en-US/splunkd/__raw/services/receivers/simple';

interface Call {
    url: string;
    init: any;
}

/** A fake fetch that records each call and answers with `respond()`. */
const fakeFetch = (calls: Call[], respond: () => Promise<any>): any => (url: string, init: any): Promise<any> => {
    calls.push({ url, init });
    return respond();
};
const answer = (code: number) => (): Promise<any> => Promise.resolve({ ok: code >= 200 && code < 300, status: code });
const unreachable = (): Promise<any> => Promise.reject(new TypeError('Failed to fetch'));
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A minimal audit event; the writer only serialises it. */
const ev = (seq: number, extra?: Record<string, unknown>): any => ({
    category: 'local_only',
    timestamp: '2026-10-16T12:00:00.000Z',
    user: 'audit_test_user',
    sessionId: 's-audit-test',
    seq,
    promptId: 'audit_test_prompt',
    rowCount: 0,
    executionMs: 1,
    ok: true,
    ...(extra || {}),
});

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, ok: boolean, detail: string): void => {
        checks += 1;
        if (!ok) {
            failures += 1;
            process.stderr.write(`FAIL auditWriteHealth ${label}: ${detail}\n`);
        }
    };
    const eq = (label: string, actual: unknown, expected: unknown): void =>
        check(label, JSON.stringify(actual) === JSON.stringify(expected),
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

    const writerSrc = read(path.join(HOME, 'components/ai/audit/auditWriter.ts'));
    const providerSrc = read(path.join(HOME, 'state/AIAssistantProvider.tsx'));
    const bannerSrc = read(path.join(HOME, 'components/ai/chat/PrivacyBanner.tsx'));
    const panelSrc = read(path.join(HOME, 'components/ai/chat/AIAssistant.tsx'));

    /* ============================ E. the index name ============================ */
    // Read first: the writer's module-level index name is checked before
    // anything in this run could set it.

    const settingsConf = read(path.join(DEF, 'ai_assistant_settings.conf'));
    const shippedMatch = /^audit_index_name\s*=\s*(\S+)\s*$/m.exec(settingsConf);
    const shipped = shippedMatch ? shippedMatch[1] : '';
    check('E1 ai_assistant_settings.conf ships an audit_index_name', shipped.length > 0, 'no audit_index_name line');
    const macroStanza = /^\[sap_logserv_audit_idx_macro\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(read(path.join(DEF, 'macros.conf')));
    const macroDef = macroStanza ? (/^definition\s*=\s*(.+?)\s*$/m.exec(macroStanza[1]) || [])[1] : undefined;
    eq('E2 the audit macro reads the shipped index', macroDef, `index="${shipped}"`);
    const indexesConf = fs.existsSync(DATA_TA_INDEXES) ? read(DATA_TA_INDEXES) : '';
    check('E3 the Data TA\'s indexes.conf defines the shipped index',
        indexesConf.split('\n').some((l) => l.trim() === `[${shipped}]`), DATA_TA_INDEXES);
    eq('E4 the writer starts on the shipped index', aw.getLocalAuditIndex(), shipped);
    eq('E5 aiConfigApi DEFAULT_AI_CONFIG.audit_index_name is the shipped index',
        aiApi.DEFAULT_AI_CONFIG.audit_index_name, shipped);
    eq('E6 AIAssistantConfig DEFAULT_AI_ASSISTANT_CONFIG.auditIndexName is the shipped index',
        aiCfg.DEFAULT_AI_ASSISTANT_CONFIG.auditIndexName, shipped);

    // A stored row with an empty or missing audit_index_name resolves to the
    // default; a set one is kept. readAIConfig reads the KV Store row first.
    const G: any = globalThis as any;
    const realFetch = G.fetch;
    const kvRow = (row: Record<string, unknown>): any => (): Promise<any> =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(row) });
    const readWith = async (row: Record<string, unknown>): Promise<string> => {
        aiApi.clearAIConfigCache();
        G.fetch = kvRow(row);
        try {
            return (await aiApi.readAIConfig()).audit_index_name;
        } finally {
            G.fetch = realFetch;
            aiApi.clearAIConfigCache();
        }
    };
    eq('E7 an empty stored audit_index_name falls back to the shipped index',
        await readWith({ _key: 'defaults', audit_index_name: '' }), shipped);
    eq('E8 a missing stored audit_index_name falls back to the shipped index',
        await readWith({ _key: 'defaults', enabled: '1' }), shipped);
    eq('E9 a stored audit_index_name is kept', await readWith({ _key: 'defaults', audit_index_name: 'site_audit' }), 'site_audit');

    const walk = (dir: string, out: string[]): string[] => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((e: any) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, out);
            else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
        });
        return out;
    };
    const quoted = ["'", '"'].map((q) => q + OLD_INDEX + q);
    const stale = walk(HOME, []).filter((f) => {
        const src = fs.readFileSync(f, 'utf8');
        return quoted.some((q) => src.indexOf(q) !== -1);
    }).map((f) => path.relative(HOME, f));
    check('E10 the old audit index name is quoted nowhere in the web source', stale.length === 0, stale.join(', '));

    /* ============================ A. the channel ============================ */

    check('A0 the forwarder is off for this run', aw.getAuditForwarderConfig().enabled === false,
        'another suite left the HEC forwarder enabled');
    check('A0b the channel is exported', typeof aw.onAuditWriteResult === 'function', typeof aw.onAuditWriteResult);

    const logged: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...args: any[]): void => {
        logged.push(args.map((a) => String(a)).join(' '));
    };
    console.warn = console.error;

    const results: any[] = [];
    const writers: any[] = [];
    const newWriter = (fetchImpl: any, endpoint?: string): any => {
        const w = new aw.AuditWriter({ fetchImpl, endpoint, flushIntervalMs: 3600000, flushBatchSize: 100000 });
        writers.push(w);
        return w;
    };
    // Registered before the recording listener: its throw must not stop it.
    const unsubThrowing = aw.onAuditWriteResult(() => {
        throw new Error('listener failure (expected in this test)');
    });
    const unsub = aw.onAuditWriteResult((r: any) => results.push(r));
    let unsubAgain: () => void = () => undefined;
    const realDocument = G.document;
    const hadDocument = Object.prototype.hasOwnProperty.call(G, 'document');

    try {
        // A1: a flush Splunk refuses, as it does for a user without edit_tcp or edit_log_alert_event.
        const calls403: Call[] = [];
        const w403 = newWriter(fakeFetch(calls403, answer(403)), '/test/receivers');
        w403.record(ev(1));
        w403.record(ev(2));
        const t0 = Date.now();
        await w403.flush();
        const r1 = results[0] || {};
        check('A1 a refused flush reports ok false, HTTP 403, its 2 events',
            results.length === 1 && r1.ok === false && r1.status === 403 && r1.events === 2
            && typeof r1.when === 'number' && r1.when >= t0, JSON.stringify(results));
        check('A1b the flush keeps its console line',
            logged.indexOf('[AuditWriter] flush failed: HTTP 403. 2 events dropped.') !== -1, JSON.stringify(logged));
        const i403 = (calls403[0] || {}).init || {};
        check('A1c a flush POSTs once, same-origin, with the CSRF headers, and is no keepalive request',
            calls403.length === 1 && calls403[0].url === '/test/receivers' && i403.method === 'POST'
            && i403.credentials === 'same-origin' && (i403.headers || {})['X-Requested-With'] === 'XMLHttpRequest'
            && 'X-Splunk-Form-Key' in (i403.headers || {}) && i403.keepalive !== true,
            JSON.stringify(calls403));

        // A2: a flush whose request throws (no response).
        const wDown = newWriter(fakeFetch([], unreachable), '/test/receivers');
        wDown.record(ev(3));
        await wDown.flush();
        const r2 = results[1] || {};
        check('A2 a flush that throws reports ok false, status null, its event',
            results.length === 2 && r2.ok === false && r2.status === null && r2.events === 1, JSON.stringify(results));
        check('A2b the flush keeps its console line', logged.some((l) => l.indexOf('[AuditWriter] flush threw:') === 0),
            JSON.stringify(logged));

        // A3: an accepted flush.
        const wOk = newWriter(fakeFetch([], answer(200)), '/test/receivers');
        wOk.record(ev(4));
        wOk.record(ev(5));
        wOk.record(ev(6));
        await wOk.flush();
        const r3 = results[2] || {};
        check('A3 an accepted flush reports ok true, HTTP 200, its 3 events',
            results.length === 3 && r3.ok === true && r3.status === 200 && r3.events === 3, JSON.stringify(results));

        // A4 / A5: postOneOff, refused and throwing; both resolve (fail-open).
        const callsOne: Call[] = [];
        await aw.AuditWriter.postOneOff(ev(7), fakeFetch(callsOne, answer(403)));
        const r4 = results[3] || {};
        check('A4 a refused postOneOff reports ok false, HTTP 403, 1 event',
            results.length === 4 && r4.ok === false && r4.status === 403 && r4.events === 1, JSON.stringify(results));
        check('A4b postOneOff keeps its console line',
            logged.indexOf('[AuditWriter] postOneOff failed: HTTP 403. Event dropped.') !== -1, JSON.stringify(logged));
        check('A4c postOneOff writes to receivers/simple on the writer\'s index',
            callsOne.length === 1 && callsOne[0].url
                === `${RECEIVERS}?source=logserv_ai_assistant&sourcetype=logserv:ai_assistant:audit&index=${shipped}`,
            JSON.stringify(callsOne.map((c) => c.url)));
        await aw.AuditWriter.postOneOff(ev(8), fakeFetch([], unreachable));
        const r5 = results[4] || {};
        check('A5 a postOneOff that throws reports ok false, status null',
            results.length === 5 && r5.ok === false && r5.status === null && r5.events === 1, JSON.stringify(results));
        check('A5b postOneOff keeps its console line', logged.some((l) => l.indexOf('[AuditWriter] postOneOff threw:') === 0),
            JSON.stringify(logged));

        // A6: unsubscribing stops delivery (the throwing listener goes too).
        unsub();
        unsubThrowing();
        const wAfter = newWriter(fakeFetch([], answer(403)), '/test/receivers');
        wAfter.record(ev(9));
        await wAfter.flush();
        check('A6 an unsubscribed listener hears nothing more', results.length === 5, JSON.stringify(results));
        unsubAgain = aw.onAuditWriteResult((r: any) => results.push(r));

        /* ============================ D. the unload write ============================ */

        check('D1 no Beacon API left in the writer', writerSrc.indexOf('sendBeacon') === -1,
            'auditWriter.ts still names sendBeacon (it cannot set the CSRF header)');
        check('D2 pagehide and beforeunload still trigger the unload write',
            writerSrc.indexOf("addEventListener('pagehide', () => this.flushOnUnload())") !== -1
            && writerSrc.indexOf("addEventListener('beforeunload', () => this.flushOnUnload())") !== -1,
            'the constructor no longer wires flushOnUnload to pagehide and beforeunload');

        const callsU: Call[] = [];
        const wU = newWriter(fakeFetch(callsU, answer(200)));
        wU.record(ev(10));
        wU.record(ev(11));
        G.document = { cookie: 'other=1; splunkweb_csrf_token_8000=tok%2Fen; last=2' };
        try {
            wU.flushOnUnload();
        } finally {
            if (hadDocument) G.document = realDocument;
            else delete G.document;
        }
        const u = callsU[0] || { url: '', init: {} };
        const uh = u.init.headers || {};
        check('D3 the unload write is one keepalive fetch: POST, same-origin',
            callsU.length === 1 && u.init.keepalive === true && u.init.method === 'POST' && u.init.credentials === 'same-origin',
            JSON.stringify(callsU));
        eq('D4 the unload write carries the CSRF form key from the cookie, and the Splunk Web headers',
            [uh['X-Splunk-Form-Key'], uh['X-Requested-With'], uh['Content-Type']],
            ['tok/en', 'XMLHttpRequest', 'application/json']);
        eq('D5 the unload write goes to receivers/simple on the writer\'s index', u.url,
            `${RECEIVERS}?source=logserv_ai_assistant&sourcetype=logserv:ai_assistant:audit&index=${shipped}`);
        eq('D6 the unload write sends the pending events, in order', u.init.body,
            [ev(10), ev(11)].map((e) => JSON.stringify(e)).join('\n'));
        await nextTick();
        const rU = results[5] || {};
        check('D7 the unload write\'s outcome is reported',
            results.length === 6 && rU.ok === true && rU.status === 200 && rU.events === 2, JSON.stringify(results));
        wU.flushOnUnload();
        check('D8 the unload write empties the buffer (a second one sends nothing)', callsU.length === 1,
            JSON.stringify(callsU.length));

        // Over the keepalive limit: the newest events that fit, in order.
        const limit: number = aw.KEEPALIVE_BODY_LIMIT_BYTES;
        check('D9 the keepalive body limit stays under the browsers\' 64 KiB', limit > 0 && limit <= 64 * 1024, String(limit));
        // Multi-byte text, so a count in characters would be wrong.
        const wide = String.fromCharCode(0xe9, 0x20ac) + String.fromCodePoint(0x1f600);
        const many = Array.from({ length: 200 }, (_x, i) => ev(i + 1, { spl: `${wide} ${'x'.repeat(400)} ${wide}`.repeat(2) }));
        const bytesOf = (events: any[]): number => Buffer.byteLength(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
        const fit = aw.fitKeepaliveBatch(many, limit);
        const sentEvents = many.slice(many.length - fit.sent);
        check('D10 an oversized batch sends some and drops the rest', fit.sent > 0 && fit.dropped > 0
            && fit.sent + fit.dropped === many.length, JSON.stringify({ sent: fit.sent, dropped: fit.dropped }));
        eq('D11 the events sent are the newest, in order', fit.body, sentEvents.map((e) => JSON.stringify(e)).join('\n'));
        check('D12 the body fits the limit in UTF-8 bytes, and one more event would not',
            Buffer.byteLength(fit.body, 'utf8') <= limit && bytesOf(many.slice(many.length - fit.sent - 1)) > limit,
            `${Buffer.byteLength(fit.body, 'utf8')} bytes for ${fit.sent} events, limit ${limit}`);
        const all = bytesOf(many.slice(0, 3));
        eq('D13 a batch exactly at the limit is sent whole', aw.fitKeepaliveBatch(many.slice(0, 3), all).sent, 3);
        eq('D14 one byte under it drops the oldest event', aw.fitKeepaliveBatch(many.slice(0, 3), all - 1).sent, 2);

        const callsBig: Call[] = [];
        const wBig = newWriter(fakeFetch(callsBig, answer(200)));
        many.forEach((e) => wBig.record(e));
        logged.length = 0;
        wBig.flushOnUnload();
        check('D15 the unload write sends that fitted body',
            callsBig.length === 1 && callsBig[0].init.body === fit.body, JSON.stringify(callsBig.length));
        check('D16 and says how many it dropped',
            logged.some((l) => l.indexOf(`[AuditWriter] unload flush: ${fit.dropped} of ${many.length} events dropped`) === 0),
            JSON.stringify(logged));
        await nextTick();
        const rBig = results[6] || {};
        check('D17 the fitted unload write reports the events it carried',
            results.length === 7 && rBig.ok === true && rBig.events === fit.sent, JSON.stringify(results.slice(6)));

        const callsHuge: Call[] = [];
        const wHuge = newWriter(fakeFetch(callsHuge, answer(200)));
        wHuge.record(ev(1, { spl: 'y'.repeat(limit + 1) }));
        logged.length = 0;
        wHuge.flushOnUnload();
        check('D18 one event over the limit sends nothing, and says so', callsHuge.length === 0
            && logged.some((l) => l.indexOf('[AuditWriter] unload flush: 1 of 1 events dropped') === 0),
            JSON.stringify({ calls: callsHuge.length, logged }));

        /* ============================ F. one-off events (build 392) ============================ */
        // The Settings page posts an acknowledgement's event and then saves: each case changes the forwarder or
        // the index while the event's local write is in flight, as that save does.
        const startCfg = aw.getAuditForwarderConfig();
        const HEC = 'https://hec.example.invalid:8088';
        const hecUrl = `${HEC}/services/collector/event`;
        const indexUrl = (idx: string): string =>
            `${RECEIVERS}?source=logserv_ai_assistant&sourcetype=logserv:ai_assistant:audit&index=${idx}`;
        const fwdOn = { enabled: true, url: HEC, hecToken: 'f-test-token', index: '', source: 'f_test' };
        try {
            aw.setAuditForwarderConfig(fwdOn);
            const callsF1: Call[] = [];
            await aw.AuditWriter.postOneOff(ev(21), (url: string, init: any): Promise<any> => {
                callsF1.push({ url, init });
                if (callsF1.length === 1) {
                    aw.setAuditForwarderConfig({ enabled: false, hecToken: 'f-later-token' });
                    aw.setLocalAuditIndex('renamed_audit_idx');
                }
                return Promise.resolve({ ok: true, status: 200 });
            });
            eq('F1 forwarding on when the event was posted: written to its index, then forwarded, though switched '
                + 'off meanwhile', callsF1.map((c) => c.url), [indexUrl(shipped), hecUrl]);
            eq('F2 the forward carries the token in place when the event was posted',
                (((callsF1[1] || {}).init || {}).headers || {}).Authorization, 'Splunk f-test-token');

            aw.setAuditForwarderConfig({ ...startCfg, enabled: false });
            aw.setLocalAuditIndex(shipped);
            const callsF3: Call[] = [];
            await aw.AuditWriter.postOneOff(ev(22), (url: string, init: any): Promise<any> => {
                callsF3.push({ url, init });
                if (callsF3.length === 1) {
                    aw.setAuditForwarderConfig(fwdOn);
                }
                return Promise.resolve({ ok: true, status: 200 });
            });
            eq('F3 forwarding off when the event was posted: written locally only, though switched on meanwhile',
                callsF3.map((c) => c.url), [indexUrl(shipped)]);

            aw.setAuditForwarderConfig(fwdOn);
            aw.setLocalAuditIndex(shipped);
            const callsF4: Call[] = [];
            await aw.AuditWriter.postOneOff(ev(23), (url: string, init: any): Promise<any> => {
                callsF4.push({ url, init });
                if (callsF4.length === 1) {
                    aw.setLocalAuditIndex('renamed_audit_idx');
                }
                return Promise.resolve(url === hecUrl ? { ok: false, status: 503 } : { ok: true, status: 200 });
            });
            const failRecord = callsF4[2] ? JSON.parse(callsF4[2].init.body) : {};
            eq('F4 a failed forward\'s record goes to the event\'s index, not the one renamed meanwhile',
                [callsF4.map((c) => c.url), failRecord.category, failRecord.reason],
                [[indexUrl(shipped), hecUrl, indexUrl(shipped)], 'audit_forwarder_failure', 'http_503']);
        } finally {
            aw.setAuditForwarderConfig(startCfg);
            aw.setLocalAuditIndex(shipped);
        }
        eq('F5 the forwarder and the index are restored',
            [aw.getAuditForwarderConfig(), aw.getLocalAuditIndex()], [startCfg, shipped]);
    } finally {
        console.error = realError;
        console.warn = realWarn;
        unsub();
        unsubThrowing();
        unsubAgain();
        await Promise.all(writers.map((w) => w.close()));
    }

    /* ============================ B. the problem state ============================ */

    const f1 = { ok: false, status: 403, when: 1000, events: 2 };
    const f2 = { ok: false, status: null, when: 2000, events: 3 };
    const okR = { ok: true, status: 200, when: 3000, events: 1 };
    const p1 = aw.nextAuditWriteProblem(null, f1);
    eq('B1 a failed write starts the problem', p1, { status: 403, when: 1000, dropped: 2 });
    const p2 = aw.nextAuditWriteProblem(p1, f2);
    eq('B2 the next failure extends it: latest status, first time, events added up', p2,
        { status: null, when: 1000, dropped: 5 });
    eq('B3 a successful write clears it', aw.nextAuditWriteProblem(p2, okR), null);
    eq('B4 a success with no problem stays clear', aw.nextAuditWriteProblem(null, okR), null);

    const importMatch = /import \{([^}]*)\} from '\.\.\/components\/ai\/audit\/auditWriter';/.exec(providerSrc);
    const imported = importMatch ? importMatch[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
    check('B5 AIAssistantProvider imports the channel and the problem reducer',
        ['onAuditWriteResult', 'nextAuditWriteProblem', 'AuditWriteProblem'].every((n) => imported.indexOf(n) !== -1),
        JSON.stringify(imported));
    check('B6 it subscribes in an effect whose cleanup unsubscribes',
        /useEffect\(\s*\(\)\s*=>\s*onAuditWriteResult\(/.test(providerSrc), 'useEffect(() => onAuditWriteResult(...)) not found');
    check('B7 each outcome goes through nextAuditWriteProblem',
        providerSrc.indexOf('setAuditWriteProblem((prev) => nextAuditWriteProblem(prev, result))') !== -1,
        'setAuditWriteProblem((prev) => nextAuditWriteProblem(prev, result)) not found');
    check('B8 the context value exposes auditWriteProblem',
        providerSrc.indexOf('auditWriteProblem: AuditWriteProblem | null;') !== -1
        && /\n\s*auditWriteProblem,\n\s*\}\),/.test(providerSrc) && /, auditWriteProblem\],/.test(providerSrc),
        'the interface field, the value entry or the memo dependency is missing');

    /* ============================ C. the words ============================ */

    const fmt = (ms: number): string => `T${ms}`;
    const t403 = aw.describeAuditWriteProblem({ status: 403, when: 5, dropped: 3 }, fmt);
    const t401 = aw.describeAuditWriteProblem({ status: 401, when: 5, dropped: 1 }, fmt);
    const t500 = aw.describeAuditWriteProblem({ status: 500, when: 5, dropped: 2 }, fmt);
    const tNone = aw.describeAuditWriteProblem({ status: null, when: 5, dropped: 2 }, fmt);
    const titles = [t403, t401, t500, tNone].map((t: any) => t.title);
    check('C1 the warning says audit events are not being written',
        titles.every((t: string) => t === 'Audit events are not being written'), JSON.stringify(titles));
    check('C2 HTTP 403 names the status, both capabilities, the default user role (not power), the admin',
        ['(HTTP 403)', 'edit_log_alert_event', 'edit_tcp', "Splunk's default user role has neither",
            'Ask your Splunk admin', 'not in the audit log'].every((s) => t403.detail.indexOf(s) !== -1)
        && t403.detail.indexOf('power') === -1, t403.detail);
    check('C3 HTTP 401 leads with the ended session (reload), and names the capabilities only after it',
        ['(HTTP 401)', 'session may have ended', 'reload the page', 'edit_log_alert_event', 'edit_tcp',
            "Splunk's default user role has neither", 'not in the audit log']
            .every((s) => t401.detail.indexOf(s) !== -1)
        && t401.detail.indexOf('session may have ended') < t401.detail.indexOf('edit_log_alert_event')
        && t401.detail.indexOf('power') === -1, t401.detail);
    check('C3 ... and a 403 does not blame the session',
        t403.detail.indexOf('session may have ended') === -1 && t403.detail.indexOf('reload') === -1, t403.detail);
    check('C4 another status is named and no capability is blamed',
        t500.detail.indexOf('(HTTP 500)') !== -1 && t500.detail.indexOf('edit_tcp') === -1
        && t500.detail.indexOf('edit_log_alert_event') === -1, t500.detail);
    check('C5 no response says so and blames nothing',
        tNone.detail.indexOf('no response') !== -1 && tNone.detail.indexOf('edit_tcp') === -1
        && tNone.detail.indexOf('edit_log_alert_event') === -1
        && tNone.detail.indexOf('HTTP') === -1, tNone.detail);
    eq('C6 the count line', [t403.since, t401.since], ['3 audit events not written since T5', '1 audit event not written since T5']);
    check('C7 the list note gives the time and the reason',
        t403.modalNote.indexOf('since T5 (HTTP 403)') !== -1 && t403.modalNote.indexOf('may not be in the audit index') !== -1
        && tNone.modalNote.indexOf('(no response from Splunk)') !== -1, `${t403.modalNote} | ${tNone.modalNote}`);
    const shown = [t403, t401, t500, tNone].map((t: any) => `${t.title} ${t.detail} ${t.since} ${t.modalNote}`).join(' ');
    check('C8 no version strings in the words', !/\bv?\d+\.\d+\.\d+\b|\bbuild \d+/i.test(shown), shown);

    check('C9 the warning renders those words in an alert region',
        /export const AuditWriteWarning\b/.test(bannerSrc) && bannerSrc.indexOf('describeAuditWriteProblem(problem)') !== -1
        && /<div role="alert">[\s\S]*?\{text\.title\}[\s\S]*?\{text\.detail\}[\s\S]*?<\/div>/.test(bannerSrc),
        'AuditWriteWarning, its describeAuditWriteProblem call or its role="alert" region is missing');
    check('C10 the chat panel shows it under the privacy banner while a problem is set',
        /<PrivacyBanner[\s\S]*?\/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?\{ctx\.auditWriteProblem && <AuditWriteWarning problem=\{ctx\.auditWriteProblem\} \/>\}/
            .test(panelSrc), 'AIAssistant.tsx does not render AuditWriteWarning right under PrivacyBanner');
    check('C11 the "Audit this session" list gets the problem and shows the note',
        panelSrc.indexOf('writeProblem={ctx.auditWriteProblem}') !== -1
        && bannerSrc.indexOf('describeAuditWriteProblem(writeProblem).modalNote') !== -1,
        'AuditModal is not given writeProblem, or does not render its note');

    if (failures === 0) {
        console.log(`auditWriteHealth consistency test: ${checks} checks OK (refused, failed and accepted writes reported;`
            + ' the unload write is a keepalive fetch with the CSRF headers; the warning names'
            + ' edit_log_alert_event and edit_tcp;'
            + ` every fallback index is ${shipped})`);
    } else {
        process.stderr.write(`auditWriteHealth consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};
