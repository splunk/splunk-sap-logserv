/**
 * Build-time consistency test for utils/hostAliasApi.ts (App build 400), the KV
 * client of the host name table, driven through a fake fetch (nothing reaches
 * a network): what each write and delete sends, and what it reports.
 *
 * What it pins:
 *  - W: upsertHostAliases refuses, before any request, an empty list, more
 *    than MAX_ROWS rows, a row sanitizeAliasRow refuses and two rows with one
 *    key; it sends batch_save requests of at most BATCH_SAVE_MAX rows (1, 1000,
 *    1001 and 5000 rows give 1, 1, 2 and 5 requests), POST, same-origin, with
 *    the CSRF form key read from the cookie; each record carries its derived
 *    `_key`, the trimmed values, an empty description when there is none and
 *    updated_at, never a stored_key or a caller's updated_by;
 *  - C: a chunk counts as written only when the 200 answer is a JSON list of
 *    one key per row; a shorter list is a partial write; anything else
 *    answered with 200 (a sign-in or proxy page, an object, an empty body,
 *    null, a longer list) confirms no row; a failed chunk does not stop the
 *    others; a request that throws is a failure with no status;
 *  - M: an HTTP error names its status and Splunk's own message
 *    (messages[0].text of a JSON body, the first <msg> of an XML one, its
 *    entities decoded, on one line, at most 300 characters (code points)),
 *    nothing else - no role names; the line is read by code point, so an
 *    invisible character outside the Basic Multilingual Plane (a decoded tag
 *    character) and a lone surrogate become spaces, and the cut never splits a
 *    surrogate pair (N4), in a write's and a delete's error alike;
 *  - D: deleteHostAlias refuses a key isDeletableKey refuses before any
 *    request (a slash, a percent sign, a question mark, a number sign, a
 *    semicolon, dots alone, empty), sends one DELETE to the key, encoded,
 *    counts a 404 as deleted and throws on any other error with Splunk's text.
 *
 * Async (fetch is), so it exports `run()` for the async chain of
 * bin/check-diagnostics.js. The globals it replaces (fetch, document) are put
 * back when it ends.
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
// The harness declarations name parameters, which the base rule (not TypeScript-aware) reports as unused; _key is
// the KV Store's own field name.
/* eslint-disable no-unused-vars, no-underscore-dangle */
/* global globalThis */

declare const require: (id: string) => any;
declare const process: { stderr: { write(s: string): void } };

const api = require('./hostAliasApi');
const ha = require('./hostAlias');

const KV_PATH = '/en-US/splunkd/__raw/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_host_aliases';

interface Call {
    url: string;
    method: string;
    headers: { [k: string]: string };
    body: any;
    credentials: string;
}

/** A fetch answer: status, status text and a body read as text or as JSON (any number of times). */
const answer = (status: number, body: string, statusText = ''): any => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async (): Promise<string> => body,
    json: async (): Promise<any> => JSON.parse(body),
});

/** The keys of a batch_save body, as Splunk answers a full write. */
const keysOf = (call: Call): string => JSON.stringify((call.body || []).map((r: any) => r._key));

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, ok: boolean, detail: string): void => {
        checks += 1;
        if (!ok) {
            failures += 1;
            process.stderr.write(`FAIL ${label}: ${detail}\n`);
        }
    };
    const show = (v: unknown): string => JSON.stringify(v);

    const G: any = globalThis as any;
    const hadFetch = Object.prototype.hasOwnProperty.call(G, 'fetch');
    const realFetch = G.fetch;
    const hadDocument = Object.prototype.hasOwnProperty.call(G, 'document');
    const realDocument = G.document;
    let calls: Call[] = [];
    let respond: (call: Call, i: number) => any = (call) => answer(200, keysOf(call));
    G.document = { cookie: 'other=1; splunkweb_csrf_token_8000=tok%2Fen; last=2' };
    G.fetch = async (url: string, init: any): Promise<any> => {
        const call: Call = {
            url,
            method: String((init && init.method) || 'GET'),
            headers: (init && init.headers) || {},
            body: init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            credentials: String(init && init.credentials),
        };
        calls.push(call);
        return respond(call, calls.length - 1);
    };
    const reset = (fn?: (call: Call, i: number) => any): void => {
        calls = [];
        respond = fn || ((call: Call) => answer(200, keysOf(call)));
    };
    const rowsOf = (n: number): any[] => {
        const out: any[] = [];
        for (let i = 0; i < n; i += 1) {
            out.push({ _key: `h${i}.example.com`, match_value: `h${i}.example.com`, alias: `Host ${i}` });
        }
        return out;
    };
    const refused = async (rows: any, pattern: RegExp): Promise<string> => {
        reset();
        try {
            await api.upsertHostAliases(rows);
            return 'did not throw';
        } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            return pattern.test(m) && calls.length === 0 ? '' : `${m} (${calls.length} request(s))`;
        }
    };

    try {
        /* ---- W the writes ---- */
        check('W0 the limits', api.BATCH_SAVE_MAX === 1000 && ha.MAX_ROWS === 5000, show([api.BATCH_SAVE_MAX, ha.MAX_ROWS]));
        const w1 = await refused([], /^upsertHostAliases: no rows to write$/);
        check('W1 an empty list is refused before any request', w1 === '', w1);
        const w1b = await refused(rowsOf(5001), /^upsertHostAliases: 5001 rows; at most 5000 can be written at once$/);
        check('W1 more than 5,000 rows are refused before any request', w1b === '', w1b);
        const w1c = await refused([{ match_value: 'app01', alias: 'ok' }, { match_value: 'app02', alias: '<b>' }],
            /^upsertHostAliases: row 2 is not a valid host name row$/);
        check('W1 a row sanitizeAliasRow refuses is refused before any request', w1c === '', w1c);
        const w1d = await refused([{ match_value: 'APP01', alias: 'A' }, { match_value: 'app01.', alias: 'B' }],
            /^upsertHostAliases: row 2 repeats the host of an earlier row$/);
        check('W1 two rows with one key are refused before any request (in one batch the last would win)', w1d === '', w1d);

        const CHUNKS: Array<[number, number[]]> = [[1, [1]], [999, [999]], [1000, [1000]], [1001, [1000, 1]], [2500, [1000, 1000, 500]],
            [5000, [1000, 1000, 1000, 1000, 1000]]];
        for (let i = 0; i < CHUNKS.length; i += 1) {
            const [n, want] = CHUNKS[i];
            reset();
            // One request at a time on purpose, as the writer sends them.
            // eslint-disable-next-line no-await-in-loop
            const res = await api.upsertHostAliases(rowsOf(n));
            const sizes = calls.map((c) => (Array.isArray(c.body) ? c.body.length : -1));
            const firstKeys = calls.map((c) => c.body[0]._key);
            const wantFirst = want.map((_x, j) => `h${j * 1000}.example.com`);
            check(`W2 ${n} rows go in batches of at most 1000: ${show(want)}`, show(sizes) === show(want) && res.written === n
                && res.failures.length === 0 && show(firstKeys) === show(wantFirst), show({ sizes, firstKeys, res }));
        }
        reset();
        await api.upsertHostAliases(rowsOf(1));
        const c0 = calls[0];
        check('W3 a batch_save request: POST to the collection\'s batch_save, same-origin, the CSRF and JSON headers', !!c0
            && c0.url === `${KV_PATH}/batch_save` && c0.method === 'POST' && c0.credentials === 'same-origin'
            && c0.headers['X-Splunk-Form-Key'] === 'tok/en' && c0.headers['X-Requested-With'] === 'XMLHttpRequest'
            && c0.headers['Content-Type'] === 'application/json', show(c0));
        const before = Math.floor(Date.now() / 1000);
        reset();
        await api.upsertHostAliases([{ _key: 'something-else', stored_key: 'foreign-1', match_value: ' App01.Example.com. ',
            alias: ' Payroll ', updated_by: 'someone', updated_at: 1 },
        { _key: 'x', match_value: '::ffff:192.0.2.10', alias: 'Edge', description: ' d ' }]);
        const after = Math.floor(Date.now() / 1000);
        const recs = calls.length === 1 ? calls[0].body : [];
        const r0 = recs[0] || {};
        const r1 = recs[1] || {};
        check('W4 each record: the derived _key, trimmed values, an empty description when none, updated_at now; no'
            + ' stored_key, no updated_by passed in (with no signed-in user none is written)',
        recs.length === 2 && r0._key === 'app01.example.com' && r0.match_value === 'App01.Example.com.' && r0.alias === 'Payroll'
            && r0.description === '' && r0.updated_at >= before && r0.updated_at <= after && !('stored_key' in r0)
            && !('updated_by' in r0) && Object.keys(r0).sort().join(',') === '_key,alias,description,match_value,updated_at'
            && r1._key === '192.0.2.10' && r1.description === 'd', show(recs));

        /* ---- C what counts as written ---- */
        const one = async (body: string, status = 200, n = 3): Promise<any> => {
            reset(() => answer(status, body, status === 200 ? 'OK' : ''));
            return api.upsertHostAliases(rowsOf(n));
        };
        const NOT_CONFIRMED: Array<[string, string]> = [
            ['a sign-in page', '<!doctype html><html><body>Sign in</body></html>'],
            ['an object', '{"saved":3}'],
            ['an empty body', ''],
            ['null', 'null'],
            ['a longer list', '["a","b","c","d"]'],
            ['a string', '"ok"'],
        ];
        for (let i = 0; i < NOT_CONFIRMED.length; i += 1) {
            const [what, body] = NOT_CONFIRMED[i];
            // eslint-disable-next-line no-await-in-loop
            const res = await one(body);
            check(`C1 a 200 answer that is ${what} confirms no row`, res.written === 0 && show(res.failures)
                === show([{ from: 0, to: 3, status: 200, message: 'the server did not confirm the rows' }]), show(res));
        }
        const partial = await one('["h0.example.com","h1.example.com"]');
        check('C2 a shorter list is a partial write', partial.written === 2 && show(partial.failures)
            === show([{ from: 0, to: 3, status: 200, message: 'the server confirmed 2 of 3 rows' }]), show(partial));
        const full = await one('["h0.example.com","h1.example.com","h2.example.com"]');
        check('C3 a list of one key per row confirms the chunk', full.written === 3 && full.failures.length === 0, show(full));
        reset((call, i) => (i === 0 ? answer(500, '', 'Internal Server Error') : answer(200, keysOf(call))));
        const firstFails = await api.upsertHostAliases(rowsOf(1001));
        check('C4 a failed chunk does not stop the next one', calls.length === 2 && firstFails.written === 1
            && show(firstFails.failures) === show([{ from: 0, to: 1000, status: 500, message: 'HTTP 500 Internal Server Error' }]),
        show(firstFails));
        reset((call, i) => {
            if (i === 1) {
                throw new Error('Failed to fetch');
            }
            return answer(200, keysOf(call));
        });
        const thrown = await api.upsertHostAliases(rowsOf(2001));
        check('C5 a request that throws is a failure with no status, and the others still go', calls.length === 3
            && thrown.written === 1001 && show(thrown.failures) === show([{ from: 1000, to: 2000, status: null, message: 'Failed to fetch' }]),
        show(thrown));

        /* ---- M the server's own message ---- */
        const errOf = async (status: number, statusText: string, body: string): Promise<string> => {
            reset(() => answer(status, body, statusText));
            const res = await api.upsertHostAliases(rowsOf(1));
            return res.failures.length === 1 && res.written === 0 ? res.failures[0].message : `unexpected ${show(res)}`;
        };
        const xml = await errOf(400, 'Bad Request', '<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <messages>\n'
            + '    <msg type="ERROR">Request exceeds API limits - max_documents_per_batch_save &lt;= 500 &amp; more</msg>\n'
            + '  </messages>\n</response>\n');
        check('M1 an XML error: the status and the first <msg>, its entities decoded', xml
            === 'HTTP 400 Bad Request: Request exceeds API limits - max_documents_per_batch_save <= 500 & more', xml);
        const json = await errOf(403, 'Forbidden', '{"messages":[{"type":"ERROR","text":"You (user=x) do not have permission to'
            + ' perform this operation"}]}');
        check('M2 a JSON error: the status and messages[0].text, and no role names', json
            === 'HTTP 403 Forbidden: You (user=x) do not have permission to perform this operation'
            && !/\b(admin|sc_admin|sc_subadmin|power)\b/.test(json), json);
        const plain = await errOf(503, 'Service Unavailable', 'upstream connect error');
        check('M3 a body that is neither JSON nor XML: the status line only', plain === 'HTTP 503 Service Unavailable', plain);
        const empty = await errOf(500, '', '{"messages":[]}');
        check('M3 no message in the body: the status only', empty === 'HTTP 500', empty);
        const nonText = await errOf(500, '', '{"messages":[{"text":5}]}');
        check('M3 a message that is not text: the status only', nonText === 'HTTP 500', nonText);
        const firstJson = await errOf(500, '', '{"messages":[{"type":"ERROR","text":"first"},{"type":"WARN","text":"second"}]}');
        const firstXml = await errOf(500, '', '<response><messages><msg type="ERROR">first</msg><msg type="WARN">second</msg></messages></response>');
        check('M3 of several messages the first is named, in JSON and in XML', firstJson === 'HTTP 500: first' && firstXml === 'HTTP 500: first',
            show([firstJson, firstXml]));
        const long = await errOf(500, '', show({ messages: [{ text: new Array(401).join('x') }] }));
        check('M4 a long message is cut to 300 characters and "..."', long === `HTTP 500: ${new Array(301).join('x')}...`,
            `${long.length} characters`);
        const odd = await errOf(400, 'Bad Request', `<response><msg>a${String.fromCharCode(0x202e)}b\n  c&#x41;&#65;&#xD800;</msg></response>`);
        check('M5 one line: a direction mark and a line break are spaces, character references decoded, an invalid one kept', odd
            === 'HTTP 400 Bad Request: a b cAA&#xD800;', odd);
        // N4: oneLine reads by code point. A character outside the Basic Multilingual Plane is checked as itself, so a
        // decoded tag character becomes a space like U+200B; a lone surrogate becomes a space; and the cut at 300
        // characters counts code points, so it never leaves half a surrogate pair before the "...".
        const cp = (code: number): string => String.fromCodePoint(code);
        const rep = (s: string, n: number): string => new Array(n + 1).join(s);
        const msgOf = (text: string): string => show({ messages: [{ type: 'ERROR', text }] });
        const halfPair = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
        const tags = await errOf(500, '', '<response><messages><msg type="ERROR">Bad &#xE0041;&#xE0042; key &#x200B; here</msg>'
            + '</messages></response>');
        check('M6 a decoded tag character (outside the BMP) is a space, as U+200B is', tags === 'HTTP 500: Bad key here'
            && !ha.hasForbiddenChars(tags), show(tags));
        const astralJson = await errOf(500, '', msgOf(`a${cp(0xe0020)}b${cp(0xe007f)}${cp(0x1d173)}c`));
        check('M6 astral invisible characters in a JSON message are spaces too', astralJson === 'HTTP 500: a b c', show(astralJson));
        const lone = await errOf(500, '', msgOf(`a${String.fromCharCode(0xd83d)}b${String.fromCharCode(0xdc00)}c`));
        check('M6 a lone surrogate is a space', lone === 'HTTP 500: a b c' && !halfPair.test(lone), show(lone));
        const keptPair = await errOf(500, '', msgOf(`ok ${cp(0x1f600)} ${cp(0x20000)}`));
        check('M6 a character outside the BMP that shows is kept whole', keptPair === `HTTP 500: ok ${cp(0x1f600)} ${cp(0x20000)}`,
            show(keptPair));
        const atCut = await errOf(500, '', msgOf(`${rep('x', 299)}${cp(0x1f600)}tail`));
        check('M7 the cut counts code points: 299 + an emoji keeps the whole emoji, then "..."',
            atCut === `HTTP 500: ${rep('x', 299)}${cp(0x1f600)}...` && !halfPair.test(atCut), show(atCut.slice(-8)));
        const y301 = await errOf(500, '', msgOf(rep('y', 301)));
        const y300 = await errOf(500, '', msgOf(rep('y', 300)));
        check('M7 301 characters: the first 300 and "..."; 300 characters are not cut', y301 === `HTTP 500: ${rep('y', 300)}...`
            && y300 === `HTTP 500: ${rep('y', 300)}`, show([y301.length, y300.length]));
        const emoji300 = await errOf(500, '', msgOf(rep(cp(0x1f600), 300)));
        const emoji301 = await errOf(500, '', msgOf(rep(cp(0x1f600), 301)));
        check('M7 300 emoji (600 UTF-16 units) are not cut; 301 give 300 and "..."', emoji300 === `HTTP 500: ${rep(cp(0x1f600), 300)}`
            && emoji301 === `HTTP 500: ${rep(cp(0x1f600), 300)}...` && !halfPair.test(emoji301), show([emoji300.length, emoji301.length]));
        const spaceCut = await errOf(500, '', msgOf(`${rep('z', 299)} tail`));
        check('M7 the cut text is trimmed before the "..."', spaceCut === `HTTP 500: ${rep('z', 299)}...`, show(spaceCut.slice(-8)));

        /* ---- D deletes ---- */
        const BAD_KEYS = ['', '.', '..', '?', '#', ';', '?x=1', 'a#b', 'a;b', 'a/b', 'a%2Fb', '%2e%2e', 'x/..', 'a\\b',
            `a${String.fromCharCode(0x200b)}b`];
        const badSent: string[] = [];
        for (let i = 0; i < BAD_KEYS.length; i += 1) {
            reset();
            try {
                // eslint-disable-next-line no-await-in-loop
                await api.deleteHostAlias(BAD_KEYS[i]);
                badSent.push(`${show(BAD_KEYS[i])} did not throw`);
            } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                if (!/^deleteHostAlias: refused/.test(m) || calls.length !== 0) {
                    badSent.push(`${show(BAD_KEYS[i])}: ${m} (${calls.length} request(s))`);
                }
            }
        }
        check('D1 a key isDeletableKey refuses throws before any request', badSent.length === 0, badSent.join('; '));
        reset(() => answer(200, '{}'));
        await api.deleteHostAlias('2001:db8::1');
        const d0 = calls[0];
        check('D2 one DELETE to the key, encoded, same-origin, with the CSRF header', calls.length === 1 && !!d0
            && d0.url === `${KV_PATH}/2001%3Adb8%3A%3A1` && d0.method === 'DELETE' && d0.credentials === 'same-origin'
            && d0.headers['X-Splunk-Form-Key'] === 'tok/en' && d0.body === undefined, show(calls));
        reset(() => answer(404, '{"messages":[{"type":"ERROR","text":"Could not find object."}]}', 'Not Found'));
        let gone = 'resolved';
        try {
            await api.deleteHostAlias('random-key-1');
        } catch (e) {
            gone = e instanceof Error ? e.message : String(e);
        }
        check('D3 a row already gone (404) counts as deleted', gone === 'resolved' && calls.length === 1
            && calls[0].url === `${KV_PATH}/random-key-1`, gone);
        reset(() => answer(403, '{"messages":[{"type":"ERROR","text":"Not allowed"}]}', 'Forbidden'));
        let denied = 'resolved';
        try {
            await api.deleteHostAlias('app01');
        } catch (e) {
            denied = e instanceof Error ? e.message : String(e);
        }
        check('D4 another error throws with the status and Splunk\'s own text', denied === 'KV Store delete failed: HTTP 403: Not allowed',
            denied);
        reset(() => answer(500, 'oops', 'Internal Server Error'));
        let plainDenied = 'resolved';
        try {
            await api.deleteHostAlias('app01');
        } catch (e) {
            plainDenied = e instanceof Error ? e.message : String(e);
        }
        check('D4 with no message in the body: the status only', plainDenied === 'KV Store delete failed: HTTP 500', plainDenied);
        reset(() => answer(500, '<response><messages><msg type="ERROR">a&#xE0041;b&#x200B;c</msg></messages></response>', ''));
        let tagDenied = 'resolved';
        try {
            await api.deleteHostAlias('app01');
        } catch (e) {
            tagDenied = e instanceof Error ? e.message : String(e);
        }
        check('D4 a delete error\'s message is on one line, read by code point (N4)', tagDenied === 'KV Store delete failed: HTTP 500: a b c',
            show(tagDenied));
    } catch (e) {
        failures += 1;
        process.stderr.write(`FAIL hostAliasApi.consistency-test threw: ${e instanceof Error ? e.stack : String(e)}\n`);
    } finally {
        if (hadFetch) {
            G.fetch = realFetch;
        } else {
            delete G.fetch;
        }
        if (hadDocument) {
            G.document = realDocument;
        } else {
            delete G.document;
        }
    }

    if (failures > 0) {
        process.stderr.write(`hostAliasApi.consistency-test: ${failures} of ${checks} checks FAILED\n`);
    } else {
        console.log(`hostAliasApi.consistency-test: ${checks} checks passed`);
    }
    return failures;
};
