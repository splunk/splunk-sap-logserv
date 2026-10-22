/**
 * Build-time consistency test for the [sap:abap:icm] search-time fields
 * (App build 378, item icm).
 *
 * The App's props.conf, eventtypes.conf, tags.conf and the AI-facing
 * sourcetype metadata lookup are READ here, not restated: every EXTRACT of
 * the stanza is compiled as a JavaScript RegExp (the same named-group syntax
 * as Splunk's PCRE for these patterns; `in source` runs on the source path)
 * and the stanza's EVALs are run by a small interpreter for the subset they
 * use (if, case, ==, field, string). So a change to the shipped text is
 * tested as shipped. Fixture lines are the dev_icm shapes of the Demo Gen
 * templates (abap/icm/templates.jsonl line numbers given) in the form Splunk
 * indexes them, plus marked SYNTHETIC lines for shapes Demo Gen does not have
 * (a session in client 400 / 800, an "*** ERROR =>" line, a "*** LOG" line, a
 * quoted "*** ERROR =>" mid-line, the JSON-escaped form real ingest keeps).
 *
 * What it pins:
 *  - the three digits after a session ID (T<n>_U<n>_M<n>) are the SAP client,
 *    `sap_client`; no extraction names them icm_status_code, nothing aliases
 *    or evaluates `status` or `action` (dev_icm has no HTTP status), so a
 *    session in client 400 to 999 is not an error;
 *  - the session's user and terminal columns give `icm_user` / `icm_terminal`
 *    and an EMPTY column sets no field;
 *  - `icm_severity` is the line's own "*** ERROR =>" / "*** WARNING =>" class,
 *    anchored at the start of the line (after the [Thr <id>] prefix): a LOG
 *    line or a quoted "*** ERROR =>" later in a line gives none;
 *  - `icm_is_error` is "true" exactly on an ERROR line (a string boolean, so
 *    the numeric-vs-string lint table keeps it);
 *  - `src` / `dest` follow the connection's direction (`icm_conn_role`): the
 *    side that opened the connection is src;
 *  - every field a rollup, the topology or the ES asset feed reads
 *    (icm_request_type, icm_transaction_id, icm_program, icm_tasks,
 *    icm_memory, icm_peer_ip, icm_local_ip, icm_protocol) still extracts;
 *  - sap:abap:icm is in no eventtype, so in no CIM data model;
 *  - the AI-facing sourcetype metadata row for sap:abap:icm (the model is told
 *    to follow its idioms) names the ICM fields and offers no HTTP status.
 * Splunk's own PCRE and eval are proven separately with the read-only
 * makeresults probes (testing/app378_s156/handoff/icm/probes/).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

// Standalone script, not a module.
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');

const DEF = path.resolve(__dirname, '../../../../resources/splunk/default');
const read = (f: string): string => fs.readFileSync(path.join(DEF, f), 'utf8').replace(/\r\n/g, '\n');

let icFailures = 0;
let icChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    icChecks += 1;
    if (!ok) {
        icFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

/* ============================ the stanza, as shipped ============================ */

const stanzaLines = (text: string, name: string): string[] => {
    const out: string[] = [];
    let cur: string | null = null;
    text.split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            cur = h[1];
            return;
        }
        if (cur === name && line.trim() !== '' && !/^\s*#/.test(line)) out.push(line);
    });
    return out;
};

const ST = stanzaLines(read('props.conf'), 'sap:abap:icm');
interface Extract { name: string; re: RegExp; field: string }
const EXTRACTS: Extract[] = [];
const EVALS: Array<{ field: string; expr: string }> = [];
const ALIASES: Array<{ from: string; to: string }> = [];
ST.forEach((line) => {
    let m = /^EXTRACT-([^\s=]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
        const inSrc = /^(.*) in (\w+)$/.exec(m[2]);
        EXTRACTS.push({ name: m[1], re: new RegExp(inSrc ? inSrc[1] : m[2]), field: inSrc ? inSrc[2] : '_raw' });
        return;
    }
    m = /^EVAL-([^\s=]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
        EVALS.push({ field: m[1], expr: m[2] });
        return;
    }
    m = /^FIELDALIAS-[^\s=]+\s*=\s*(.*)$/i.exec(line);
    if (m) {
        const pairs = m[1].match(/(\S+)\s+AS\s+(\S+)/gi) || [];
        pairs.forEach((p) => {
            const q = /(\S+)\s+AS\s+(\S+)/i.exec(p) as RegExpExecArray;
            ALIASES.push({ from: q[1], to: q[2] });
        });
    }
});
const groupNames = (re: RegExp): string[] => (re.source.match(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g) || [])
    .map((g) => g.slice(3, -1));
const ALL_GROUPS = ([] as string[]).concat(...EXTRACTS.map((x) => groupNames(x.re)));

check('S1 the stanza was read', ST.length > 10 && EXTRACTS.length >= 14 && EVALS.length >= 4,
    `${ST.length} lines, ${EXTRACTS.length} EXTRACTs, ${EVALS.length} EVALs`);
check('S2 no extraction names the SAP client icm_status_code (it is the client, not an HTTP status)',
    ALL_GROUPS.indexOf('icm_status_code') === -1 && !ST.some((l) => /\bicm_status_code\b/.test(l)), ALL_GROUPS.join(', '));
check('S3 nothing aliases or evaluates status or action: dev_icm records no HTTP status',
    ALIASES.every((a) => a.to !== 'status' && a.to !== 'action')
    && EVALS.every((e) => e.field !== 'status' && e.field !== 'action')
    && ALL_GROUPS.indexOf('status') === -1 && ALL_GROUPS.indexOf('action') === -1,
    JSON.stringify({ aliases: ALIASES, evals: EVALS.map((e) => e.field) }));
check('S4 every EVAL reads EXTRACT outputs only (calculated fields do not see each other)',
    EVALS.every((e) => EVALS.every((o) => o.field === e.field
        || !new RegExp(`(^|[^A-Za-z0-9_])${o.field}([^A-Za-z0-9_]|$)`).test(e.expr.replace(/"(?:[^"\\]|\\.)*"/g, '""')))),
    EVALS.map((e) => e.field).join(', '));
check('S5 icm_is_error stays a string boolean (the lint table and the rollup arms compare it to "true")',
    EVALS.some((e) => e.field === 'icm_is_error' && /"true"/.test(e.expr) && /"false"/.test(e.expr)
        && /\bicm_severity\b/.test(e.expr) && !/like\(|\d/.test(e.expr.replace(/"(?:[^"\\]|\\.)*"/g, '""'))),
    JSON.stringify(EVALS.filter((e) => e.field === 'icm_is_error')));
check('S6 the severity class is anchored at the line start', EXTRACTS.some((x) => groupNames(x.re).indexOf('icm_severity') !== -1
    && x.re.source.charAt(0) === '^'), EXTRACTS.filter((x) => groupNames(x.re).indexOf('icm_severity') !== -1).map((x) => x.re.source).join(' | '));

/* ============================ a small eval interpreter ============================ */
// The subset the stanza's EVALs use: if(c, a, b), case(c1, v1, ...), X=="lit",
// a field, a "string". A comparison with an absent field is null; if() takes
// its else branch on null; case() with no true arm gives null.

type V = string | boolean | null;
const splitArgs = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let inQ = false;
    let cur = '';
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '"' && s[i - 1] !== '\\') inQ = !inQ;
        if (!inQ && ch === '(') depth += 1;
        if (!inQ && ch === ')') depth -= 1;
        if (!inQ && depth === 0 && ch === ',') {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
};
const evalExpr = (expr: string, f: Record<string, string>): V => {
    const e = expr.trim();
    let m = /^"((?:[^"\\]|\\.)*)"$/.exec(e);
    if (m) return m[1].replace(/\\(.)/g, '$1');
    m = /^(if|case)\((.*)\)$/.exec(e);
    if (m) {
        const args = splitArgs(m[2]);
        if (m[1] === 'if') return evalExpr(args[0], f) === true ? evalExpr(args[1], f) : evalExpr(args[2], f);
        for (let i = 0; i + 1 < args.length; i += 2) if (evalExpr(args[i], f) === true) return evalExpr(args[i + 1], f);
        return null;
    }
    m = /^([A-Za-z_]\w*)\s*==\s*(".*")$/.exec(e);
    if (m) {
        const l = f[m[1]];
        return l === undefined ? null : l === evalExpr(m[2], f);
    }
    if (/^[A-Za-z_]\w*$/.test(e)) return f[e] === undefined ? null : f[e];
    throw new Error(`icmProps: the interpreter does not know "${e}" - extend it with the stanza`);
};

const SOURCE = '/usr/sap/XCP/D00/work/dev_icm';
const fieldsOf = (raw: string): Record<string, string> => {
    const f: Record<string, string> = {};
    EXTRACTS.forEach((x) => {
        // (named groups are ES2018; the webapp tsconfig's lib is es2017, Node runs them)
        const m = x.re.exec(x.field === 'source' ? SOURCE : raw) as
            (RegExpExecArray & { groups?: Record<string, string | undefined> }) | null;
        const groups = m ? m.groups : undefined;
        if (!groups) return;
        Object.keys(groups).forEach((g) => {
            const v = groups[g];
            if (v !== undefined && f[g] === undefined) f[g] = v;
        });
    });
    // Aliases run before the EVALs; the EVALs see only the extractions.
    ALIASES.forEach((a) => { if (f[a.from] !== undefined) f[a.to] = f[a.from]; });
    const ex = { ...f };
    EVALS.forEach((e) => {
        let v: V = null;
        try {
            v = evalExpr(e.expr, ex);
        } catch (err) {
            check(`E EVAL-${e.field} is in the interpreter's subset`, false, (err as Error).message);
        }
        if (v === null) delete f[e.field];
        else f[e.field] = String(v);
    });
    return f;
};

/* ============================ fixtures ============================ */

const THR = '[Thr 131e8aa2b3ea1]';
const FIX: Array<{ label: string; raw: string; want: Record<string, string | null> }> = [
    {
        label: 'DG L1 ASYNC_RFC session, client 200, user, empty terminal',
        raw: '[Thr 1419bffb4c6cd]              ASYNC_RFC T229_U23835_M0, 200, BATCH_ALM, , time=10:35:59, W0, program=SAPMSSY1, low priority, memory=0, tasks=12, appl info=NoClient: Call numbuffer with key 200/APPL_LOG  /      /01/0000, tcode=          ',
        want: {
            sap_client: '200', icm_user: 'BATCH_ALM', icm_terminal: null, icm_request_type: 'ASYNC_RFC',
            icm_transaction_id: 'T229_U23835_M0', icm_program: 'SAPMSSY1', icm_tasks: '12', icm_memory: '0',
            icm_time: '10:35:59', thread_id: '1419bffb4c6cd', sap_sid: 'XCP', sap_instance: 'D00',
            icm_severity: null, icm_is_error: 'false', status: null, action: null, icm_status_code: null,
            src: null, dest: null, app: 'sap_abap_icm',
        },
    },
    {
        label: 'DG L61 HTTP_NORMAL session, client 000, empty user, terminal IP',
        raw: `${THR}                HTTP_NORMAL T464_U6061_M0, 000, , 10.186.72.197, time=11:28:45, W2, program=SAPMHTTP, normal priority, memory=0, tasks=0, appl info=P=/neev/CAS , tcode=          `,
        want: { sap_client: '000', icm_user: null, icm_terminal: '10.186.72.197', icm_request_type: 'HTTP_NORMAL', icm_is_error: 'false', status: null },
    },
    {
        label: 'DG L66 INTERNAL session, client 000, SAPSYS',
        raw: '[Thr 1419bffb4c6cd]   INTERNAL T15_U17185_M0, 000, SAPSYS, , time=08:00:12, W0, program=SAPMSSY8, high priority, memory=0, tasks=1, appl info=, tcode=          ',
        want: { sap_client: '000', icm_user: 'SAPSYS', icm_terminal: null, icm_program: 'SAPMSSY8', icm_is_error: 'false' },
    },
    {
        label: 'DG L2 connection, role Client: the ICM opened it, local is src',
        raw: `${THR}              role: Client, protocol: H2, local: 10.186.72.120:23952, peer: 10.186.72.81:1129, id: 54/7067329, SNI: `,
        want: {
            icm_conn_role: 'Client', icm_protocol: 'H2', icm_local_ip: '10.186.72.120', icm_peer_ip: '10.186.72.81',
            src: '10.186.72.120', dest: '10.186.72.81', sap_client: null, icm_transaction_id: null, icm_is_error: 'false',
        },
    },
    {
        label: 'DG L69 connection, role Server: a client opened it, peer is src',
        raw: '[Thr 131c9cc0f0c69]                role: Server, protocol: HTTPS, local: 10.186.72.92:44300, peer: 10.186.72.197:8212, id: 306/2956062, SNI: vhxsdxcpai02.hec.xsd-vlab.com',
        want: { icm_conn_role: 'Server', icm_protocol: 'HTTPS', src: '10.186.72.197', dest: '10.186.72.92' },
    },
    {
        label: 'DG L124 WARNING line',
        raw: `${THR} *** WARNING => HTTP Server: connection closed prematurely by client 10.186.72.197 (718519/1104306 url:vhxsdsinwd01.hec.xsd-vlab.com:44380/neev/CAS) {007a52a3} {root-id=1DE1B4BB90F21FE0BEEE31502B0A04E5} [http_plg.c 2158] `,
        want: { icm_severity: 'WARNING', icm_is_error: 'false', sap_client: null, src: null },
    },
    {
        label: 'DG L6 root-id continuation line: no field of the session or connection shapes',
        raw: '[Thr 131b7dd3e4b35]               {00351e93} {root-id=02F23C334F911EDDA8E405366948A251} [icxxconn.c 3617] ',
        want: { sap_client: null, icm_severity: null, icm_conn_role: null, icm_is_error: 'false', thread_id: '131b7dd3e4b35' },
    },
    {
        label: 'SYNTHETIC session in client 400: a client, not an HTTP 4xx',
        raw: `${THR}   ASYNC_RFC T12_U345_M0, 400, BATCH_ALM, , time=10:35:59, W0, program=SAPMSSY1, low priority, memory=0, tasks=1, appl info=, tcode=          `,
        want: { sap_client: '400', icm_is_error: 'false', status: null, action: null },
    },
    {
        label: 'SYNTHETIC session in client 800, user and terminal name',
        raw: `${THR}   HTTP_NORMAL T7_U88_M1, 800, JDOE, wks4711, time=09:01:02, W3, program=SAPMHTTP, normal priority, memory=0, tasks=0, appl info=P=/sap/bc/ui5 , tcode=          `,
        want: { sap_client: '800', icm_user: 'JDOE', icm_terminal: 'wks4711', icm_is_error: 'false' },
    },
    {
        label: 'SYNTHETIC ERROR line: the one ICM error',
        raw: `${THR} *** ERROR => IcmConnInitServerSSL: SSL handshake failed (-1) [icxxconn.c 2730]`,
        want: { icm_severity: 'ERROR', icm_is_error: 'true' },
    },
    {
        label: 'SYNTHETIC WARNING with no [Thr] prefix',
        raw: '*** WARNING => Connection request from (17/4711/0) to host: x, service: 44380 failed (NIECONN_REFUSED)',
        want: { icm_severity: 'WARNING', icm_is_error: 'false' },
    },
    {
        label: 'SYNTHETIC LOG line: no class',
        raw: `${THR} *** LOG Q0I=> NiIRead: P=10.1.2.3:4711; L=10.1.2.4:44300 (104: Connection reset by peer) [nixxi.cpp 4628]`,
        want: { icm_severity: null, icm_is_error: 'false' },
    },
    {
        label: 'SYNTHETIC "*** ERROR =>" quoted mid-line: no class',
        raw: `${THR} IcmPlConnRead: peer said "*** ERROR => x"`,
        want: { icm_severity: null, icm_is_error: 'false' },
    },
    {
        label: 'SYNTHETIC the same, JSON-escaped as real ingest keeps it',
        raw: `${THR} IcmPlConnRead: peer said \\"*** ERROR => x\\"`,
        want: { icm_severity: null, icm_is_error: 'false' },
    },
];

FIX.forEach((fx) => {
    const got = fieldsOf(fx.raw);
    Object.keys(fx.want).forEach((k) => {
        const want = fx.want[k];
        const g = got[k] === undefined ? null : got[k];
        check(`F ${fx.label}: ${k}`, g === want, `got ${JSON.stringify(g)}, want ${JSON.stringify(want)}`);
    });
});

/* ============================ no CIM model ============================ */

const ET = read('eventtypes.conf');
const TAGS = read('tags.conf');
const icmTypes = ET.split('\n').filter((l) => !/^\s*#/.test(l) && /sourcetype\s*=\s*"?sap:abap:icm"?/.test(l));
check('C1 no eventtype selects sap:abap:icm (dev_icm holds no Web request records)', icmTypes.length === 0, icmTypes.join(' | '));
check('C2 tags.conf tags no ICM eventtype', !/^\[eventtype=sap_abap_icm_request\]/m.test(TAGS), '');

/* ===================== the AI-facing sourcetype metadata ===================== */
// lookups/logserv_sourcetype_metadata.csv is on the AI lookup allow-list and the
// system primer tells the model to prefer its SPL idioms, so its sap:abap:icm
// row must describe the ICM trace as it is parsed: no HTTP status.

const splitCsv = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"';
                i += 1;
            } else if (ch === '"') {
                inQ = false;
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQ = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
};
const META = fs.readFileSync(path.resolve(DEF, '../lookups/logserv_sourcetype_metadata.csv'), 'utf8')
    .replace(/\r\n/g, '\n').split('\n').filter((l: string) => l.trim() !== '');
const META_HEAD = splitCsv(META[0]);
const metaIcm = META.filter((l: string) => l.indexOf('sap:abap:icm,') === 0).map(splitCsv);
check('M1 the metadata lookup has one five-column sap:abap:icm row', META_HEAD.length === 5 && metaIcm.length === 1
    && metaIcm[0].length === META_HEAD.length, `${metaIcm.length} row(s), ${metaIcm.length ? metaIcm[0].length : 0} column(s)`);
if (metaIcm.length === 1) {
    const row: Record<string, string> = {};
    META_HEAD.forEach((h, i) => { row[h] = metaIcm[0][i] || ''; });
    const keys = row.key_fields.split(/\s+/);
    check('M2 its key fields are the ICM fields the stanza extracts, with no HTTP status',
        ['sap_client', 'icm_severity', 'icm_is_error', 'icm_request_type'].every((k) => keys.indexOf(k) !== -1)
        && keys.every((k) => ['status', 'method', 'uri', 'response_time_ms', 'sap_inst'].indexOf(k) === -1)
        && keys.every((k) => ['sap_sid', 'sap_instance', 'host'].indexOf(k) !== -1 || ALL_GROUPS.indexOf(k) !== -1
            || EVALS.some((e) => e.field === k)), row.key_fields);
    check('M3 its description and sample SPL offer no HTTP status (dev_icm records none)',
        !/\bstatus\b|HTTP\/HTTPS access/i.test(`${row.description} ${row.sample_spl}`)
        && /\bicm_severity\s*=\s*ERROR\b/.test(row.sample_spl), `${row.description} | ${row.sample_spl}`);
}

/* ===================================================================== */

if (icFailures > 0) {
    process.stderr.write(`\nicmProps.consistency-test: ${icFailures} failure(s) of ${icChecks}\n`);
    process.exit(1);
}
console.log(`icmProps.consistency-test: OK (${icChecks} checks; ${FIX.length} dev_icm lines)`);
