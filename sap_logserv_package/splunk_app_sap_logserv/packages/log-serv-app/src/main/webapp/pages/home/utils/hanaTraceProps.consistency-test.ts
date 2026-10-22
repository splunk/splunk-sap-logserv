/**
 * Build-time consistency test for the [sap:hana:tracelogs] search-time
 * extractions (App build 378, item i1; decisions U39 / U42).
 *
 * The App's props.conf is READ here, not restated: every EXTRACT of the
 * stanza is compiled as a JavaScript RegExp (the same named-group syntax as
 * Splunk's PCRE for these patterns; `in source` runs on the source path) and
 * the stanza's EVALs are run by a small interpreter for the subset they use
 * (case, match, tonumber, null, ==, =, *, /). So a change to the shipped
 * text is tested as shipped. Fixture lines cover each file kind, in the form
 * Splunk indexes them: standard trace lines of the nameserver, indexserver,
 * dpserver, daemon and alert files; backup.log (system and tenant) with a
 * numeric or a Z offset; hdbcons.trc command timings in usec, msec and sec,
 * JSON-escaped (real ingest keeps the escapes: \" and \t as text) and with a
 * real TAB; the SQL trace, load and availability record files; continuation
 * lines. Real shapes are from the session-154 samples, host and SID names
 * replaced by Demo Gen ones.
 *
 * What it pins:
 *  - a standard trace line gives pid, level, component, source file and line,
 *    and only a line that STARTS with the trace prefix does (a continuation
 *    line or a quoted prefix later in a line gives nothing);
 *  - a backup.log line gives its level and component (LOGBCKUP), not the
 *    "of" / "service:" the unanchored patterns took;
 *  - an hdbcons timing gives hana_op, the duration and its unit, and
 *    hana_op_duration_ms in ms for usec, msec and sec;
 *  - severity: the trace level, else the backup level, else none (null) for
 *    the record files (hdbcons, SQL trace, loads, availability), else UNKNOWN;
 *  - hana_trace_file_type per file;
 *  - the stanza has no severity alias (U39: an alias runs before the EVALs, so
 *    it never saw hana_trace_severity) and hana_op_duration_ms is the EVAL's
 *    alone (no msec-only EXTRACT beside it).
 * Splunk's own PCRE and eval escaping are proven separately with read-only
 * makeresults probes (testing/app378_s156/handoff/C-conf/probes/).
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

const PROPS = path.resolve(__dirname, '../../../../resources/splunk/default/props.conf');

let htFailures = 0;
let htChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    htChecks += 1;
    if (!ok) {
        htFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

/* ============================ the stanza, as shipped ============================ */

const stanzaLines = (text: string, name: string): string[] => {
    const out: string[] = [];
    let cur: string | null = null;
    text.replace(/\r\n/g, '\n').split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            cur = h[1];
            return;
        }
        if (cur === name && line.trim() !== '' && !/^\s*#/.test(line)) out.push(line);
    });
    return out;
};

const ST = stanzaLines(fs.readFileSync(PROPS, 'utf8'), 'sap:hana:tracelogs');
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
    m = /^FIELDALIAS-[^\s=]+\s*=\s*(\S+)\s+AS\s+(\S+)\s*$/i.exec(line);
    if (m) ALIASES.push({ from: m[1], to: m[2] });
});

check('S1 the stanza was read', ST.length > 10 && EXTRACTS.length >= 8 && EVALS.length >= 4,
    `${ST.length} lines, ${EXTRACTS.length} EXTRACTs, ${EVALS.length} EVALs`);
check('S2 no severity alias (U39): an alias runs before the EVALs and never saw hana_trace_severity',
    ALIASES.every((a) => a.to !== 'severity') && !ST.some((l) => /^FIELDALIAS-severity\b/.test(l)),
    JSON.stringify(ALIASES));
check('S3 the component alias stays', ALIASES.some((a) => a.from === 'hana_trace_component' && a.to === 'component'),
    JSON.stringify(ALIASES));
const groupNames = (re: RegExp): string[] => (re.source.match(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g) || [])
    .map((g) => g.slice(3, -1));
check('S4 hana_op_duration_ms is the EVAL\'s alone (no msec-only EXTRACT beside it)',
    EVALS.some((e) => e.field === 'hana_op_duration_ms')
    && EXTRACTS.every((x) => groupNames(x.re).indexOf('hana_op_duration_ms') === -1), '');
check('S5 every EVAL reads EXTRACT outputs and source only (calculated fields do not see each other)',
    EVALS.every((e) => EVALS.every((o) => o.field === e.field
        || !new RegExp(`(^|[^A-Za-z0-9_])${o.field}([^A-Za-z0-9_]|$)`).test(e.expr.replace(/"(?:[^"\\]|\\.)*"/g, '""')))),
    EVALS.map((e) => e.field).join(', '));

/* ============================ a small eval interpreter ============================ */
// The subset the stanza's EVALs use. Splunk eval string literals: \\ is a
// backslash and \" a quote; any other backslash stays (so "\." reaches the
// regex as \.). The probes prove that reading in Splunk.

type Val = string | number | boolean | null;
interface Tok { t: string; v: string }
const tokenize = (s: string): Tok[] => {
    const out: Tok[] = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) {
            i += 1;
        } else if (c === '"') {
            let j = i + 1;
            let v = '';
            while (j < s.length && s[j] !== '"') {
                if (s[j] === '\\' && (s[j + 1] === '"' || s[j + 1] === '\\')) {
                    v += s[j + 1];
                    j += 2;
                } else {
                    v += s[j];
                    j += 1;
                }
            }
            if (j >= s.length) throw new Error(`unterminated string in ${s}`);
            out.push({ t: 'str', v });
            i = j + 1;
        } else if (/[0-9]/.test(c)) {
            const m = /^[0-9]+(?:\.[0-9]+)?/.exec(s.slice(i)) as RegExpExecArray;
            out.push({ t: 'num', v: m[0] });
            i += m[0].length;
        } else if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)) as RegExpExecArray;
            out.push({ t: 'id', v: m[0] });
            i += m[0].length;
        } else if (s.slice(i, i + 2) === '==' || s.slice(i, i + 2) === '!=') {
            out.push({ t: 'op', v: s.slice(i, i + 2) });
            i += 2;
        } else if ('(),=*/'.indexOf(c) !== -1) {
            out.push({ t: c === '=' || c === '*' || c === '/' ? 'op' : c, v: c });
            i += 1;
        } else {
            throw new Error(`unexpected '${c}' in ${s}`);
        }
    }
    return out;
};
type ENode = { k: 'lit'; v: Val } | { k: 'field'; n: string } | { k: 'call'; f: string; a: ENode[] }
    | { k: 'bin'; op: string; l: ENode; r: ENode };
const parse = (src: string): ENode => {
    const tk = tokenize(src);
    let p = 0;
    const peek = (): Tok | undefined => tk[p];
    const take = (t?: string): Tok => {
        const x = tk[p];
        if (!x || (t && x.t !== t)) throw new Error(`expected ${t} at ${p} in ${src}`);
        p += 1;
        return x;
    };
    const primary = (): ENode => {
        const x = take();
        if (x.t === 'str') return { k: 'lit', v: x.v };
        if (x.t === 'num') return { k: 'lit', v: Number(x.v) };
        if (x.t === 'id') {
            if (peek() && (peek() as Tok).t === '(') {
                take('(');
                const a: ENode[] = [];
                if ((peek() as Tok).t !== ')') {
                    a.push(cmp());
                    while ((peek() as Tok).t === ',') {
                        take(',');
                        a.push(cmp());
                    }
                }
                take(')');
                return { k: 'call', f: x.v.toLowerCase(), a };
            }
            return { k: 'field', n: x.v };
        }
        if (x.t === '(') {
            const e = cmp();
            take(')');
            return e;
        }
        throw new Error(`unexpected token ${x.v} in ${src}`);
    };
    const mul = (): ENode => {
        let l = primary();
        while (peek() && (peek() as Tok).t === 'op' && ((peek() as Tok).v === '*' || (peek() as Tok).v === '/')) {
            const op = take().v;
            l = { k: 'bin', op, l, r: primary() };
        }
        return l;
    };
    const cmp = (): ENode => {
        const l = mul();
        if (peek() && (peek() as Tok).t === 'op' && ['==', '=', '!='].indexOf((peek() as Tok).v) !== -1) {
            const op = take().v;
            return { k: 'bin', op, l, r: mul() };
        }
        return l;
    };
    const e = cmp();
    if (p !== tk.length) throw new Error(`trailing tokens in ${src}`);
    return e;
};
const evaluate = (n: ENode, f: Record<string, string>): Val => {
    if (n.k === 'lit') return n.v;
    if (n.k === 'field') return Object.prototype.hasOwnProperty.call(f, n.n) ? f[n.n] : null;
    if (n.k === 'bin') {
        const l = evaluate(n.l, f);
        const r = evaluate(n.r, f);
        if (n.op === '*' || n.op === '/') {
            if (typeof l !== 'number' || typeof r !== 'number') return null;
            return n.op === '*' ? l * r : l / r;
        }
        if (l === null || r === null) return false;
        return n.op === '!=' ? String(l) !== String(r) : String(l) === String(r);
    }
    const a = n.a;
    switch (n.f) {
    case 'case':
        for (let i = 0; i + 1 < a.length; i += 2) {
            if (evaluate(a[i], f) === true) return evaluate(a[i + 1], f);
        }
        return null;
    case 'match': {
        const s = evaluate(a[0], f);
        const re = evaluate(a[1], f);
        if (s === null || typeof re !== 'string') return null;
        return new RegExp(re).test(String(s));
    }
    case 'tonumber': {
        const s = evaluate(a[0], f);
        if (s === null) return null;
        const v = Number(s);
        return Number.isFinite(v) ? v : null;
    }
    case 'null':
        return null;
    default:
        throw new Error(`function ${n.f} is not modelled`);
    }
};
const EVAL_AST = EVALS.map((e) => ({ field: e.field, ast: parse(e.expr) }));

/** The search-time fields of one event: every EXTRACT (first match wins per
 *  field, as no two EXTRACTs here match one line), then every EVAL - each
 *  reading the extracted fields only - and the component alias. */
const fieldsOf = (source: string, raw: string): Record<string, string | number | null> => {
    const f: Record<string, string> = { source, _raw: raw };
    EXTRACTS.forEach((x) => {
        // (named groups are ES2018; the webapp tsconfig's lib is es2017, Node runs them)
        const m = x.re.exec(x.field === 'source' ? source : raw) as
            (RegExpExecArray & { groups?: Record<string, string | undefined> }) | null;
        const groups = m ? m.groups : undefined;
        if (!groups) return;
        Object.keys(groups).forEach((g) => {
            const v = groups[g];
            if (v !== undefined && !(g in f)) f[g] = v;
        });
    });
    const out: Record<string, string | number | null> = { ...f };
    EVAL_AST.forEach((e) => {
        const v = evaluate(e.ast, f);
        out[e.field] = v === null || typeof v === 'boolean' ? null : v;
    });
    ALIASES.forEach((a) => {
        out[a.to] = out[a.from] !== undefined ? out[a.from] : null;
    });
    delete out.source;
    delete out._raw;
    Object.keys(out).forEach((k) => {
        if (out[k] === null) delete out[k];
    });
    return out;
};

/* ============================ fixtures ============================ */

const T = '/usr/sap/XCJ/HDB02/vhxsdxcjdb01/trace/';
const TT = `${T}DB_XCP/`;
const BS = '\\';
const ESC_TAB = `${BS}t`;
const ESC_Q = `${BS}"`;
const hdb = (cmd: string, dur: string, tab: string, q: string): string =>
    [`${q}${cmd}${q}`, 'FALSE', 'FALSE', '2026-09-30 23:56:37.794', 'TRUE', '2026-09-30 23:56:37.794', dur, 'FALSE',
        '2026-09-30 23:56:37.794', '0'].join(tab);

interface Fx { id: string; source: string; raw: string; want: Record<string, string | number> }
const FX: Fx[] = [
    {
        id: 'nameserver i',
        source: `${T}nameserver_vhxsdxcjdb01.30201.155.trc`,
        raw: '[3760372]{-1}[-1/-1] 2026-09-30 23:56:11.996552 i Basis            TopologyUtil.cpp(01225) : done.',
        want: { hana_trace_pid: '3760372', hana_trace_level: 'i', hana_trace_component: 'Basis',
            hana_trace_source_file: 'TopologyUtil.cpp', hana_trace_source_line: '01225', hana_trace_severity: 'INFO',
            hana_trace_file_type: 'trace', component: 'Basis' },
    },
    {
        id: 'nameserver w',
        source: `${T}nameserver_vhxsdxcjdb01.30201.155.trc`,
        raw: '[3760372]{-1}[-1/-1] 2026-09-30 23:56:11.492718 w HanaNetRPC       HanaNetExt.cpp(00065) : initializing network for client-only operation',
        want: { hana_trace_pid: '3760372', hana_trace_level: 'w', hana_trace_component: 'HanaNetRPC',
            hana_trace_source_file: 'HanaNetExt.cpp', hana_trace_source_line: '00065', hana_trace_severity: 'WARNING',
            hana_trace_file_type: 'trace', component: 'HanaNetRPC' },
    },
    {
        id: 'nameserver alert e',
        source: `${T}nameserver_alert_vhxsdxcjdb01.trc`,
        raw: '[724946]{-1}[-1/-1] 2026-09-29 10:55:54.602447 e Crypto           backupRootKeys.cpp(00180) : Export of backup failed: Root key backup passphrase not set',
        want: { hana_trace_pid: '724946', hana_trace_level: 'e', hana_trace_component: 'Crypto',
            hana_trace_source_file: 'backupRootKeys.cpp', hana_trace_source_line: '00180', hana_trace_severity: 'ERROR',
            hana_trace_file_type: 'alert', component: 'Crypto' },
    },
    {
        id: 'indexserver alert e, connection id',
        source: `${TT}indexserver_alert_vhxsdxcjdb01.trc`,
        raw: '[2020829]{317305}[-1/-1] 2026-03-19 13:03:10.372600 e SQLSession       sm_handler.cc(03274) : CHANNEL      : (sockfd:6584, part:9) open_time=5356 ms',
        want: { hana_trace_pid: '2020829', hana_trace_level: 'e', hana_trace_component: 'SQLSession',
            hana_trace_source_file: 'sm_handler.cc', hana_trace_source_line: '03274', hana_trace_severity: 'ERROR',
            hana_trace_file_type: 'alert', component: 'SQLSession', hana_tenant_sid: 'XCP' },
    },
    {
        id: 'daemon i, JSON-escaped quotes',
        source: '/usr/sap/XHQ/HDB04/vhxsdxhqdb01/trace/daemon_vhxsdxhqdb01.30400.653.trc',
        raw: `[3572113]{-1}[-1/-1] 2026-03-19 00:13:52.796217 i Daemon           Daemon.cpp(01143) : Daemon state ${ESC_Q}running${ESC_Q}, runlevels [current:reached:target]=[5:5:5]`,
        want: { hana_trace_pid: '3572113', hana_trace_level: 'i', hana_trace_component: 'Daemon',
            hana_trace_source_file: 'Daemon.cpp', hana_trace_source_line: '01143', hana_trace_severity: 'INFO',
            hana_trace_file_type: 'trace', component: 'Daemon', sap_sid: 'XHQ', hana_instance: 'HDB04',
            hana_host: 'vhxsdxhqdb01' },
    },
    {
        id: 'dpserver i, lower-case component',
        source: `${TT}dpserver_vhxsdxcjdb01.30249.057.trc`,
        raw: '[653303]{-1}[-1/-1] 2026-03-19 23:40:25.386264 i sr_dataaccess    DisasterRecoveryPrimaryImpl.cpp(01024) : Replication Snapshot dropped: 860514',
        want: { hana_trace_pid: '653303', hana_trace_level: 'i', hana_trace_component: 'sr_dataaccess',
            hana_trace_source_file: 'DisasterRecoveryPrimaryImpl.cpp', hana_trace_source_line: '01024',
            hana_trace_severity: 'INFO', hana_trace_file_type: 'trace', component: 'sr_dataaccess' },
    },
    {
        id: 'backup.log INFO (system)',
        source: `${T}backup.log`,
        raw: '2026-09-30T23:58:24+00:00  P0009574      1a0f4c14fd2 INFO    LOGBCKUP to file: /hana_backup/XCJ/log/SYSTEMDB/log_backup_0_0_0_0.1790812704722',
        want: { hana_backup_level: 'INFO', hana_trace_component: 'LOGBCKUP', hana_trace_severity: 'INFO',
            hana_trace_file_type: 'backup', component: 'LOGBCKUP', sap_sid: 'XCJ', hana_instance: 'HDB02',
            hana_host: 'vhxsdxcjdb01' },
    },
    {
        id: 'backup.log INFO (tenant, the old "of" / "service:" line)',
        source: `${TT}backup.log`,
        raw: '2026-09-30T23:58:02.123456+00:00  P1620204      19bffb4c6cd INFO    LOGBCKUP state of service: indexserver, vhxsdxcjdb01:30240, volume: 3, BackupLogStarted',
        want: { hana_backup_level: 'INFO', hana_trace_component: 'LOGBCKUP', hana_trace_severity: 'INFO',
            hana_trace_file_type: 'backup', component: 'LOGBCKUP', hana_tenant_sid: 'XCP' },
    },
    {
        id: 'backup.log ERROR (shape-consistent)',
        source: `${TT}backup.log`,
        raw: '2026-09-30T23:58:02+00:00  P1620204      19bffb4c6cd ERROR   LOGBCKUP state of service: indexserver, vhxsdxcjdb01:30240, volume: 3, BackupLogError',
        want: { hana_backup_level: 'ERROR', hana_trace_component: 'LOGBCKUP', hana_trace_severity: 'ERROR',
            hana_trace_file_type: 'backup', component: 'LOGBCKUP' },
    },
    {
        id: 'backup.log WARNING, Z offset (shape-consistent)',
        source: `${T}backup.log`,
        raw: '2026-09-30T23:58:02.123Z  P0010214      1a0f4c0f831 WARNING BACKUP_MONITOR retry scheduled',
        want: { hana_backup_level: 'WARNING', hana_trace_component: 'BACKUP_MONITOR', hana_trace_severity: 'WARNING',
            hana_trace_file_type: 'backup', component: 'BACKUP_MONITOR' },
    },
    {
        id: 'hdbcons usec, JSON-escaped (real form)',
        source: `${T}nameserver_vhxsdxcjdb01.30201.hdbcons.trc`,
        raw: hdb('replication info', '67.000 usec', ESC_TAB, ESC_Q),
        want: { hana_op: 'replication info', hana_op_duration: '67.000', hana_op_duration_unit: 'usec',
            hana_op_duration_ms: 0.067, hana_trace_file_type: 'hdbcons' },
    },
    {
        id: 'hdbcons msec, JSON-escaped (Demo Gen)',
        source: `${TT}indexserver_vhxsdxcjdb02.30240.hdbcons.trc`,
        raw: hdb('profiler stop', '66.246 msec', ESC_TAB, ESC_Q),
        want: { hana_op: 'profiler stop', hana_op_duration: '66.246', hana_op_duration_unit: 'msec',
            hana_op_duration_ms: 66.246, hana_trace_file_type: 'hdbcons', hana_tenant_sid: 'XCP' },
    },
    {
        id: 'hdbcons usec, decoded (real TAB and quotes)',
        source: `${TT}indexserver_vhxsdxcjdb02.30240.hdbcons.trc`,
        raw: hdb('statreg print -h -n M_SYSTEM_REPLICATION_PRIMARY_STATISTICS_', '343.000 usec', '\t', '"'),
        want: { hana_op: 'statreg print -h -n M_SYSTEM_REPLICATION_PRIMARY_STATISTICS_', hana_op_duration: '343.000',
            hana_op_duration_unit: 'usec', hana_op_duration_ms: 0.343, hana_trace_file_type: 'hdbcons' },
    },
    {
        id: 'hdbcons sec (shape-consistent)',
        source: `${T}nameserver_vhxsdxcjdb01.30201.hdbcons.trc`,
        raw: hdb('runtimedump dump', '1.5 sec', ESC_TAB, ESC_Q),
        want: { hana_op: 'runtimedump dump', hana_op_duration: '1.5', hana_op_duration_unit: 'sec',
            hana_op_duration_ms: 1500, hana_trace_file_type: 'hdbcons' },
    },
    {
        id: 'executed_statements record',
        source: `${T}nameserver_vhxsdxcjdb01.30201.executed_statements.007.trc`,
        raw: '100226;15;19740043;430467417310348;089d361a9e066e1f3955039b8dec91ed;_SYS_STATISTICS;;0;1131;;0;;;;;0;;;0;15:_SYS_STATISTICS;;0;;;;0;0;0;;;0;',
        want: { hana_trace_file_type: 'sql_trace' },
    },
    {
        id: 'executed_statements statement line',
        source: `${T}nameserver_vhxsdxcjdb01.30201.executed_statements.007.trc`,
        raw: '#ALTER SYSTEM DELETE ALL HANDLED EVENTS',
        want: { hana_trace_file_type: 'sql_trace' },
    },
    {
        id: 'expensive_statements record',
        source: `${TT}indexserver_vhxsdxcjdb01.30240.expensive_statements.863.trc`,
        raw: '346793;3310;1481b7dd3e4b35;DATASPHERE;13:svcsapdpagent;17619bffb4c6cd;67286251;HODBC.V_OBJINFO_EXT;AGGREGATED_EXECUTION;0;',
        want: { hana_trace_file_type: 'sql_trace', hana_tenant_sid: 'XCP' },
    },
    {
        id: 'loads record (an ISO time inside, not at the start)',
        source: `${TT}indexserver_vhxsdxcjdb02.30240.loads.320.trc`,
        raw: '0;3;2026-09-30T23:58:02.123456+00:00;SAPHANADB;-63;/PRA/VL_ACC_DOC;452126;0;0;en;CHECK_NO;3;0;0;transaction_id=-1, context_id=2563372;',
        want: { hana_trace_file_type: 'load_trace' },
    },
    {
        id: 'unloads record',
        source: `${TT}indexserver_vhxsdxcjdb02.30240.unloads.012.trc`,
        raw: '0;2026-09-30 23:58:02.123456;SAPHANADB;ZTABLE;12;LOW MEMORY;',
        want: { hana_trace_file_type: 'load_trace' },
    },
    {
        id: 'system_availability record',
        source: `${T}system_availability_vhxsdxcjdb01.trc`,
        raw: '0;2026-09-30 22:55:38.675240;41e414c9-105a-dd40-a1e6-8515e2017334;1;ping;;;yes;ok;yes;ok;;;vhxsdxcjdb01;;;;;worker;worker;1;1;;;;;;;',
        want: { hana_trace_file_type: 'availability' },
    },
    {
        id: 'continuation line of a trace record',
        source: `${TT}indexserver_vhxsdxcjdb01.30240.720.trc`,
        raw: '    at 12:34:56.789 i of ptime::Query::execute (Query.cpp(00123))',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'trace', hana_tenant_sid: 'XCP' },
    },
    {
        id: 'a trace prefix quoted later in a line',
        source: `${TT}indexserver_vhxsdxcjdb01.30240.720.trc`,
        raw: 'caused by: [1126718]{-1}[-1/-1] 2026-03-19 14:33:35.007793 i SQLSessionCmd    sm_manager.cc(02174) : cancel requested',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'trace' },
    },
    {
        id: 'a quoted string at the start of a trace line (no TAB: not an hdbcons timing)',
        source: `${TT}indexserver_vhxsdxcjdb01.30240.720.trc`,
        raw: '"SELECT 1 FROM DUMMY" executed in 3 msec',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'trace' },
    },
    {
        id: 'an indented continuation line in backup.log',
        source: `${T}backup.log`,
        raw: '    2026-09-30T23:58:02+00:00  P0010214      1a0f4c0f831 INFO    LOGBCKUP quoted in a message',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'backup' },
    },
    {
        // Not an entry: the word where the component goes is lower case. The
        // component must be an upper-case token (LOGBCKUP, BACKUP_MONITOR ...),
        // so the "of" / "service:" the unanchored patterns took cannot return.
        id: 'a lower-case word in the component slot of backup.log (not an entry)',
        source: `${T}backup.log`,
        raw: '2026-09-30T23:58:02+00:00  P0010214      1a0f4c0f831 INFO    of service: indexserver, volume: 3',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'backup' },
    },
    {
        id: 'a log file that is not one of the kinds',
        source: `${T}nameserver_history.log`,
        raw: 'service started',
        want: { hana_trace_severity: 'UNKNOWN', hana_trace_file_type: 'other' },
    },
];

/* Every field a fixture does not list must be ABSENT (no stray extraction);
 * the path fields are checked only where a fixture names them, and the two
 * literal fields once, in P7. */
const OPTIONAL = new Set(['sap_sid', 'hana_instance', 'hana_host', 'hana_tenant_sid', 'vendor_product', 'app']);
FX.forEach((fx) => {
    let got: Record<string, string | number | null>;
    try {
        got = fieldsOf(fx.source, fx.raw);
    } catch (e) {
        check(`F ${fx.id}`, false, `threw: ${(e as Error).message}`);
        return;
    }
    const keys = Array.from(new Set(Object.keys(got).concat(Object.keys(fx.want))))
        .filter((k) => !(OPTIONAL.has(k) && !(k in fx.want)));
    const bad = keys.filter((k) => {
        const w = fx.want[k];
        const g = got[k];
        if (w === undefined) return g !== undefined;
        if (typeof w === 'number') return typeof g !== 'number' || Math.abs(g - w) > 1e-9;
        return g !== w;
    });
    check(`F ${fx.id}`, bad.length === 0,
        bad.map((k) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(fx.want[k])}`).join('; '));
});

/* ============================ the properties the panels rely on ============================ */
const sev = (fx: Fx): string | number | null | undefined => fieldsOf(fx.source, fx.raw).hana_trace_severity;
const RECORD_KINDS = ['hdbcons', 'sql_trace', 'load_trace', 'availability'];
check('P1 every record-file line carries no severity (U39: null, so the rollup stores "(none)")',
    FX.filter((fx) => RECORD_KINDS.indexOf(String(fieldsOf(fx.source, fx.raw).hana_trace_file_type)) !== -1)
        .every((fx) => sev(fx) === undefined), '');
check('P2 every other line has a severity', FX.filter((fx) => RECORD_KINDS
    .indexOf(String(fieldsOf(fx.source, fx.raw).hana_trace_file_type)) === -1).every((fx) => typeof sev(fx) === 'string'), '');
check('P3 no backup.log entry line is UNKNOWN or carries a junk component',
    FX.filter((fx) => fx.id.indexOf('backup.log ') === 0).every((fx) => {
        const f = fieldsOf(fx.source, fx.raw);
        return f.hana_trace_severity !== 'UNKNOWN' && /^[A-Z][A-Z_]*$/.test(String(f.hana_trace_component));
    }), '');
check('P4 every hdbcons line has a duration in ms', FX.filter((fx) => /\.hdbcons\.trc$/.test(fx.source))
    .every((fx) => typeof fieldsOf(fx.source, fx.raw).hana_op_duration_ms === 'number'), '');
check('P5 only hdbcons lines carry hana_op', FX.every((fx) => ('hana_op' in fieldsOf(fx.source, fx.raw))
    === /\.hdbcons\.trc$/.test(fx.source)), '');
check('P6 the fixtures cover every file type the EVAL names',
    ['trace', 'alert', 'backup', 'hdbcons', 'sql_trace', 'load_trace', 'availability', 'other']
        .every((t) => FX.some((fx) => fieldsOf(fx.source, fx.raw).hana_trace_file_type === t)), '');

check('P7 the literal fields stay', FX.every((fx) => {
    const f = fieldsOf(fx.source, fx.raw);
    return f.vendor_product === 'SAP HANA' && f.app === 'sap_hana_tracelog';
}), '');

if (htFailures > 0) {
    process.stderr.write(`hanaTraceProps.consistency-test: ${htFailures} FAILURE(S) in ${htChecks} checks\n`);
    process.exit(1);
}
console.log(`hanaTraceProps.consistency-test: OK (${htChecks} checks; ${EXTRACTS.length} EXTRACTs and `
    + `${EVALS.length} EVALs read from props.conf, ${FX.length} fixture lines)`);
