/**
 * Build-time consistency test for sap_sid / sap_instance on Web Dispatcher
 * access events (App build 378, item wd).
 *
 * [sap:webdispatcher:access] extracts the SAP system ID and instance from the
 * log's path, /usr/sap/<SID>/<instance>/..., with the very lines the ABAP
 * stanzas use. The App's props.conf is READ here, not restated: the two
 * EXTRACTs are compiled as JavaScript RegExps (the same named-group syntax as
 * Splunk's PCRE for these patterns) and run on the `source` value, as `in
 * source` does in Splunk.
 *
 * What it pins:
 *  - the stanza carries EXTRACT-sap_sid and EXTRACT-sap_instance `in source`,
 *    byte for byte the lines of every ABAP stanza that has them, and nothing
 *    else in the stanza writes either field; the AI-facing sourcetype
 *    metadata row lists both;
 *  - every Demo Gen Web Dispatcher template gives XCP / D00 (its 250 sources
 *    are embedded below as a digest; when the Demo Gen snapshot sits beside
 *    this one, its templates.jsonl is read, must match the digest, and every
 *    line is replayed);
 *  - the other path shapes: a standalone Web Dispatcher (WDP / W00), one
 *    embedded in an ABAP ASCS instance (S4P / ASCS01), rotated files, a host
 *    segment, and the paths that give no SID or no instance;
 *  - the topology inventory leaves a Web Dispatcher out of every arm that
 *    can read the SID of its log path: the access log by sourcetype
 *    (sourcetype!="sap:webdispatcher:access") and its own ICM trace by
 *    LogServ folder (NOT clz_dir="webdispatcher": Data TA builds of
 *    2026-10-13 and earlier typed webdispatcher/icm sap:abap:icm, events they
 *    indexed keep that sourcetype, and the [sap:abap:icm] lines give them the
 *    Web Dispatcher's SID), in the aggregate and its backfill twin, byte for
 *    byte: a Web Dispatcher with its own SID on a host shared with another
 *    system must not take the host or its address over (user decision, build
 *    378). The Data TA's ICM route is read from its transforms.conf (hard
 *    failure when the Data TA source is missing, as in the gate): from its
 *    build of 2026-10-16 it takes abap/icm only (decision #11 of the build-378
 *    review), so webdispatcher/icm stays sap_logserv_logs.
 * Splunk's own PCRE is proven separately with the read-only makeresults probe
 * testing/app378_s156/handoff/wd/probes/pw1_wd_sid.spl.
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

let wdFailures = 0;
let wdChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    wdChecks += 1;
    if (!ok) {
        wdFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

/* ============================ the stanzas, as shipped ============================ */

const stanzas = (text: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    let cur: string | null = null;
    text.split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            cur = h[1];
            out[cur] = [];
            return;
        }
        if (cur !== null && line.trim() !== '' && !/^\s*#/.test(line)) out[cur].push(line);
    });
    return out;
};
const PROPS = stanzas(read('props.conf'));
const WD = PROPS['sap:webdispatcher:access'] || [];
const valuesOf = (lines: string[], key: string): string[] => lines.filter((l) => l.indexOf(`${key} = `) === 0)
    .map((l) => l.slice(key.length + 3));

const SID_KEY = 'EXTRACT-sap_sid';
const INST_KEY = 'EXTRACT-sap_instance';
const wdSid = valuesOf(WD, SID_KEY);
const wdInst = valuesOf(WD, INST_KEY);
check('S1 the Web Dispatcher stanza has one EXTRACT-sap_sid and one EXTRACT-sap_instance', WD.length > 20
    && wdSid.length === 1 && wdInst.length === 1, `${WD.length} lines, ${wdSid.length} / ${wdInst.length}`);

const abapNames = Object.keys(PROPS).filter((n) => n.indexOf('sap:abap:') === 0 && valuesOf(PROPS[n], SID_KEY).length > 0);
const abapSid = abapNames.map((n) => valuesOf(PROPS[n], SID_KEY)[0]);
const abapInst = abapNames.map((n) => valuesOf(PROPS[n], INST_KEY)[0]);
check('S2 they are byte for byte the ABAP stanzas\' lines', abapNames.length >= 8
    && abapSid.every((v) => v === wdSid[0]) && abapInst.every((v) => v === wdInst[0]),
    `${abapNames.length} ABAP stanzas; WD ${JSON.stringify(wdSid)} ${JSON.stringify(wdInst)}`);
check('S3 both read the source path (in source)', /\sin source$/.test(wdSid[0] || '') && /\sin source$/.test(wdInst[0] || ''),
    `${wdSid[0]} | ${wdInst[0]}`);
const otherWriters = WD.filter((l) => !(l.indexOf(`${SID_KEY} = `) === 0 || l.indexOf(`${INST_KEY} = `) === 0)
    && (/\(\?<(sap_sid|sap_instance)>/.test(l) || /^EVAL-(sap_sid|sap_instance)\s*=/.test(l)
        || /^FIELDALIAS-[^=]*=.*\bAS\s+(sap_sid|sap_instance)\b/i.test(l)));
check('S4 nothing else in the stanza writes sap_sid or sap_instance', otherWriters.length === 0, otherWriters.join(' | '));

// The AI-facing sourcetype metadata lookup (on the AI lookup allow-list; the primer
// tells the model to follow its idioms) lists the fields a search can group by.
const META_WD = (fs.readFileSync(path.resolve(DEF, '../lookups/logserv_sourcetype_metadata.csv'), 'utf8') as string)
    .replace(/\r\n/g, '\n').split('\n').filter((l) => l.indexOf('sap:webdispatcher:access,') === 0);
check('S5 the AI-facing sourcetype metadata row for Web Dispatcher lists sap_sid and sap_instance',
    META_WD.length === 1 && /,(?:[^,]* )?sap_sid sap_instance[ ,]/.test(META_WD[0]), META_WD.join(' | '));

const compile = (v: string): RegExp => new RegExp(v.replace(/\s+in source$/, ''));
const RX_SID = compile(wdSid[0] || '(?!)');
const RX_INST = compile(wdInst[0] || '(?!)');
const group = (re: RegExp, s: string, g: string): string | null => {
    // (named groups are ES2018; the webapp tsconfig's lib is es2017, Node runs them)
    const m = re.exec(s) as (RegExpExecArray & { groups?: Record<string, string | undefined> }) | null;
    const groups = m ? m.groups : undefined;
    const v = groups ? groups[g] : undefined;
    return v === undefined ? null : v;
};
/** The two fields of an event: only `source` is read (the EXTRACTs run `in source`). */
const fieldsOf = (source: string): { sap_sid: string | null; sap_instance: string | null } => ({
    sap_sid: group(RX_SID, source, 'sap_sid'),
    sap_instance: group(RX_INST, source, 'sap_instance'),
});

/* ============================ Demo Gen: all 250 templates ============================ */
// webdispatcher/accesslog/templates.jsonl of the Demo Gen TA 0.1.1: 250 lines,
// every one on host hec53v014018 with this one source (the ABAP dialog
// instance D00 of XCP). The digest is the per-source line count.
const DG_WD_SOURCES: Record<string, number> = { '/usr/sap/XCP/D00/log/http_access_log': 250 };
const DG_TOTAL = 250;
let dgReplayed = 0;
Object.keys(DG_WD_SOURCES).forEach((src) => {
    const f = fieldsOf(src);
    for (let i = 0; i < DG_WD_SOURCES[src]; i += 1) {
        dgReplayed += 1;
        if (f.sap_sid !== 'XCP' || f.sap_instance !== 'D00') {
            check(`D1 Demo Gen template ${dgReplayed} gives XCP / D00`, false, `${src} -> ${JSON.stringify(f)}`);
            break;
        }
    }
});
check('D1 every Demo Gen template source gives XCP / D00', dgReplayed === DG_TOTAL, `${dgReplayed} of ${DG_TOTAL} replayed`);

// The Demo Gen snapshot beside this one (package_versions/splunk_ta_sap_logserv_demo_gen_v*), when present.
// default -> splunk -> resources -> main -> src -> log-serv-app -> packages ->
// splunk_app_sap_logserv -> sap_logserv_package -> the snapshot -> package_versions
const VERSIONS = path.resolve(DEF, '../../../../../../../../../..');
const DG_REL = 'sap_logserv_package/splunk_ta_sap_logserv_demo_gen/package/templates/webdispatcher/accesslog/templates.jsonl';
let dgFile = '';
let dgDir = '';
try {
    const dirs: string[] = fs.readdirSync(VERSIONS)
        .filter((d: string) => d.indexOf('splunk_ta_sap_logserv_demo_gen_v') === 0).sort();
    dirs.forEach((d) => {
        const p = path.join(VERSIONS, d, DG_REL);
        if (fs.existsSync(p)) {
            dgFile = p;
            dgDir = d;
        }
    });
} catch (e) {
    dgFile = '';
}
let dgNote = 'the Demo Gen snapshot is not beside this one: the embedded digest of its 250 template sources was replayed';
if (dgFile) {
    const lines = (fs.readFileSync(dgFile, 'utf8') as string).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
    const counts: Record<string, number> = {};
    let bad = 0;
    lines.forEach((l, i) => {
        let t: { source?: string; _raw_template?: string } = {};
        try {
            t = JSON.parse(l);
        } catch (e) {
            check(`D2 templates.jsonl line ${i + 1} is JSON`, false, l.slice(0, 80));
            return;
        }
        const src = String(t.source || '');
        counts[src] = (counts[src] || 0) + 1;
        const f = fieldsOf(src);
        if (f.sap_sid !== 'XCP' || f.sap_instance !== 'D00') {
            bad += 1;
            if (bad <= 3) check(`D2 templates.jsonl line ${i + 1} gives XCP / D00`, false, `${src} -> ${JSON.stringify(f)}`);
        }
    });
    check('D2 the Demo Gen templates match the embedded digest (count and per-source lines)',
        lines.length === DG_TOTAL && JSON.stringify(counts) === JSON.stringify(DG_WD_SOURCES),
        `${lines.length} lines, ${JSON.stringify(counts)} in ${dgFile}`);
    check('D2 every one of them gives XCP / D00', bad === 0, `${bad} line(s) did not`);
    dgNote = `${lines.length} Demo Gen templates read and replayed from ${dgDir}`;
}

/* ============================ the other path shapes ============================ */

const PATHS: Array<{ label: string; source: string; sid: string | null; inst: string | null }> = [
    { label: 'standalone WD, SWPM layout', source: '/usr/sap/WDP/W00/log/http_access_log', sid: 'WDP', inst: 'W00' },
    { label: 'standalone WD, instance 10', source: '/usr/sap/WD1/W10/log/http_access_log', sid: 'WD1', inst: 'W10' },
    { label: 'standalone WD, one-digit instance', source: '/usr/sap/WDP/W1/log/http_access_log', sid: 'WDP', inst: 'W1' },
    { label: 'rotated file name', source: '/usr/sap/WDP/W00/log/http_access_log-20261010', sid: 'WDP', inst: 'W00' },
    { label: 'host segment under the instance', source: '/usr/sap/WDP/W00/wdhost01/log/http_access_log', sid: 'WDP', inst: 'W00' },
    { label: 'WD embedded in the ABAP ASCS instance', source: '/usr/sap/S4P/ASCS01/log/http_access_log', sid: 'S4P', inst: 'ASCS01' },
    { label: 'ABAP PAS ICM HTTP log', source: '/usr/sap/S4P/DVEBMGS00/log/http_access_log', sid: 'S4P', inst: 'DVEBMGS00' },
    { label: 'ABAP AAS ICM HTTP log', source: '/usr/sap/S4P/D01/log/http_access_log', sid: 'S4P', inst: 'D01' },
    { label: 'Java instance', source: '/usr/sap/PJ1/J00/log/http_access_log', sid: 'PJ1', inst: 'J00' },
    { label: 'manual install, sapwebdisp directory: neither', source: '/usr/sap/sapwebdisp/log/http_access_log', sid: null, inst: null },
    { label: 'SID directory, sapwebdisp below it: no instance', source: '/usr/sap/WDP/sapwebdisp/log/http_access_log', sid: 'WDP', inst: null },
    { label: 'SID directory, SYS below it: no instance', source: '/usr/sap/WDP/SYS/log/http_access_log', sid: 'WDP', inst: null },
    { label: 'outside /usr/sap (sapmnt): neither', source: '/sapmnt/WDP/log/http_access_log', sid: null, inst: null },
    { label: 'outside /usr/sap (var/log): neither', source: '/var/log/sapwebdisp/log/http_access_log', sid: null, inst: null },
    { label: 'lower-case SID directory: instance only, as in the ABAP stanzas', source: '/usr/sap/wdp/W00/log/http_access_log', sid: null, inst: 'W00' },
    { label: 'four-character SID directory: instance only', source: '/usr/sap/WDPX/W00/log/http_access_log', sid: null, inst: 'W00' },
    { label: 'Windows path: neither', source: 'D:\\usr\\sap\\WDP\\W00\\log\\http_access_log', sid: null, inst: null },
];
PATHS.forEach((p) => {
    const f = fieldsOf(p.source);
    check(`P ${p.label}`, f.sap_sid === p.sid && f.sap_instance === p.inst,
        `${p.source} -> ${JSON.stringify(f)}, want ${JSON.stringify({ sap_sid: p.sid, sap_instance: p.inst })}`);
});

/* ============== the topology inventory: no host -> SID from Web Dispatcher ============== */

const SS = stanzas(read('savedsearches.conf'));
const searchOf = (name: string): string => valuesOf(SS[name] || [], 'search')[0] || '';
// A Web Dispatcher's own ICM trace is recognised by its LogServ folder (the indexed clz_dir the Data TA writes).
// NOT keeps events that carry no clz_dir; clz_dir!= would drop them (decoded Demo Gen, data without folders).
const WD_FOLDER = 'NOT clz_dir="webdispatcher"';
const INV_ARM_PREFIX = '[search `sap_logserv_idx_macro` sap_sid=* host=* ';
const INV_ARM = '[search `sap_logserv_idx_macro` sap_sid=* host=* sourcetype!="sap:webdispatcher:access" '
    + `${WD_FOLDER} | stats count as n, max(_time) as last_seen by host, sap_sid |`;
const ICM_ARM = '[search `sap_logserv_idx_macro` sourcetype=sap:abap:icm icm_local_ip=* sap_sid=* '
    + `${WD_FOLDER} | stats count as n, max(_time) as last_seen by icm_local_ip, sap_sid |`;
const invAgg = searchOf('logserv_topology_aggregate_inventory');
const invBf = searchOf('logserv_topology_backfill_inventory');
const count = (s: string, sub: string): number => s.split(sub).length - 1;
check('I1 the inventory aggregate\'s host -> SID arm leaves Web Dispatcher events out (access log by sourcetype, own ICM'
    + ' trace by folder)', count(invAgg, INV_ARM) === 1
    && count(invAgg, INV_ARM_PREFIX) === 1, `${count(invAgg, INV_ARM)} exact / ${count(invAgg, INV_ARM_PREFIX)} host arms`);
check('I2 the inventory backfill runs the aggregate\'s search byte for byte', invAgg !== '' && invBf === invAgg,
    'logserv_topology_backfill_inventory differs from logserv_topology_aggregate_inventory');
check('I3 no other inventory arm reads Web Dispatcher access events', count(invAgg, 'sap:webdispatcher:access') === 1,
    invAgg.slice(0, 120));
check('I4 the inventory\'s ICM local IP -> SID arm leaves the Web Dispatcher\'s own ICM trace out',
    count(invAgg, ICM_ARM) === 1 && count(invAgg, 'sourcetype=sap:abap:icm') === 1,
    `${count(invAgg, ICM_ARM)} exact / ${count(invAgg, 'sourcetype=sap:abap:icm')} ICM arms`);
// Every arm of the union either pins a sourcetype a Web Dispatcher never writes, or carries the folder exclusion,
// so an arm added later cannot read the Web Dispatcher's SID unnoticed. (The arms hold no nested brackets.)
const WD_FREE = ['sap:abap:gateway', 'sap:hana:tracelogs', 'sap:saprouter'];
const invArms = invAgg.split('[search ').slice(1).map((a) => `[search ${a.split(']')[0]}`);
const unguarded = invArms.filter((a) => a.indexOf(WD_FOLDER) === -1
    && !WD_FREE.some((st) => new RegExp(`\\ssourcetype="?${st}"?\\s`).test(a)));
check('I5 every inventory arm pins a sourcetype no Web Dispatcher writes or leaves its folder out',
    invArms.length >= 5 && unguarded.length === 0, `${invArms.length} arms; unguarded: ${unguarded.join(' || ')}`);
check('I6 the folder is never excluded with clz_dir!= (it would drop every event without clz_dir)',
    count(invAgg, 'clz_dir!=') === 0 && count(invBf, 'clz_dir!=') === 0 && count(invAgg, WD_FOLDER) === 2,
    `${count(invAgg, 'clz_dir!=')} / ${count(invBf, 'clz_dir!=')} clz_dir!=, ${count(invAgg, WD_FOLDER)} exclusions`);

// The premise of I4: the Web Dispatcher's own ICM trace, where it was indexed as sap:abap:icm (Data TA builds of
// 2026-10-13 and earlier), carries ITS SID through the [sap:abap:icm] lines (the very lines S2 compares), so without
// the exclusion its local address would map to the Web Dispatcher's SID.
const ICM = PROPS['sap:abap:icm'] || [];
const icmSid = compile(valuesOf(ICM, SID_KEY)[0] || '(?!)');
const icmInst = compile(valuesOf(ICM, INST_KEY)[0] || '(?!)');
const WD_ICM_SRC = '/usr/sap/WDP/W00/work/dev_icm';
check('I7 a Web Dispatcher\'s own ICM trace (dev_icm) carries its SID and instance through [sap:abap:icm]',
    group(icmSid, WD_ICM_SRC, 'sap_sid') === 'WDP' && group(icmInst, WD_ICM_SRC, 'sap_instance') === 'W00'
    && group(icmSid, '/usr/sap/XCP/D00/work/dev_icm', 'sap_sid') === 'XCP',
    `${WD_ICM_SRC} -> ${group(icmSid, WD_ICM_SRC, 'sap_sid')} / ${group(icmInst, WD_ICM_SRC, 'sap_instance')}`);

// The Data TA's ICM route, read from the Data TA itself: from its build of 2026-10-16 it is keyed on both folder
// fields, abap/icm only, so the Web Dispatcher's ICM folder (webdispatcher/icm, the LogServ service description's
// folder for /usr/sap/<SID>/W<nn>/work/dev_icm*) keeps sap_logserv_logs. Earlier builds took every folder named icm.
// The folder exclusion stays for the events those builds indexed; supported-log-types.md and topology.md say which
// builds type the trace sap:abap:icm. JavaScript has no possessive quantifiers, so the route's skip over "_raw" is
// run with greedy twins ('++' -> '+', '*+' -> '*'): on these short envelopes they match exactly the same lines.
// default -> ... -> sap_logserv_package (8 levels up), then the Data TA source beside the App.
const DATA_TA = path.resolve(DEF, '../../../../../../../../splunk_ta_sap_logserv/package/default/transforms.conf');
let routeNote = 'Data TA transforms.conf missing';
if (!fs.existsSync(DATA_TA)) {
    check('R1 the Data TA source is beside the App (its ICM route is read from it)', false, DATA_TA);
} else {
    const ta = stanzas((fs.readFileSync(DATA_TA, 'utf8') as string).replace(/\r\n/g, '\n'));
    const route = ta['set_srctype_abap_icm'] || [];
    const rx = valuesOf(route, 'REGEX')[0] || '';
    const fmt = valuesOf(route, 'FORMAT')[0] || '';
    const env = (dir: string): string => `{"source":"/usr/sap/WDP/W00/work/dev_icm","clz_dir":"${dir}","clz_subdir":"icm"}`;
    let takesWd = true;
    let takesAbap = false;
    let compiled = true;
    try {
        const jsRx = new RegExp(rx.replace(/\+\+/g, '+').replace(/\*\+/g, '*'));
        takesWd = jsRx.test(env('webdispatcher'));
        takesAbap = jsRx.test(env('abap'));
    } catch (e) {
        compiled = false;
    }
    check('R1 the Data TA\'s ICM route types the ABAP ICM folder (abap/icm) sap:abap:icm and not the Web Dispatcher\'s'
        + ' (webdispatcher/icm)', compiled && fmt === 'sourcetype::sap:abap:icm' && takesAbap && !takesWd,
        `REGEX ${rx} FORMAT ${fmt}: compiled ${compiled}, abap/icm ${takesAbap}, webdispatcher/icm ${takesWd} - if the`
        + ' route takes webdispatcher/icm again, correct supported-log-types.md and topology.md, then this check');
    routeNote = `Data TA ICM route ${rx}`;
}

/* ===================================================================== */

if (wdFailures > 0) {
    process.stderr.write(`\nwdProps.consistency-test: ${wdFailures} failure(s) of ${wdChecks}\n`);
    process.exit(1);
}
console.log(`wdProps.consistency-test: OK (${wdChecks} checks; ${dgNote}; ${PATHS.length} other path shapes; ${routeNote})`);
