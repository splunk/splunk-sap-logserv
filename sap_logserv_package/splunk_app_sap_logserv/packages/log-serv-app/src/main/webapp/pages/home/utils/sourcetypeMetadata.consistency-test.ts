/**
 * Build-time consistency test for lookups/logserv_sourcetype_metadata.csv, the
 * AI-facing sourcetype metadata lookup.
 *
 * The lookup is on the AI lookup allow-list (splGuard ALLOWED_SPL_LOOKUPS) and
 * the system primer tells the model to prefer its SPL idioms, so a key field
 * that nothing extracts sends the model to a field that is never there, and its
 * search returns nothing. The App's props.conf, transforms.conf and fields.conf
 * and the Data TA's transforms.conf are READ here, not restated.
 *
 * What it pins:
 *  - M1 the table's shape: the five-column header, five columns on every row
 *    (RFC 4180 quoting), LF line endings, no control character but LF, a final
 *    newline, no row twice, 1 to 8 distinct key fields per row;
 *  - M2 every row names a sourcetype the pipeline produces: one a Data TA route
 *    writes (FORMAT = sourcetype::<name>) or one the App's props.conf has a
 *    stanza for (the legacy syslog);
 *  - M3 every App-owned row (sap:*, isc:bind:*, squid:*) has its props.conf
 *    stanza, and each key_fields entry is a field that stanza defines - an
 *    EXTRACT named group, an EVAL-, a FIELDALIAS target, a REPORT- transform's
 *    FORMAT names (the REGEX groups of one without FORMAT), a LOOKUP output -
 *    or one every event carries: host, source and sourcetype (the Data TA's
 *    metadata and routing transforms write them) and the indexed fields of
 *    fields.conf, each of which a Data TA WRITE_META transform must write. A
 *    dynamic key ($1::$2) is no name: a field only such a transform gives (bytes
 *    on a key=value Squid line) is missing from the native lines, so it fails;
 *  - M4 the same for the fields an App-owned row's sample_spl filters on before
 *    its first pipe, groups by, or aggregates (a field the sample makes itself,
 *    with rex, AS or eval, is its own);
 *  - M5 every sample_spl starts with the index macro and passes the AI
 *    Assistant's ad-hoc guard (splGuard.analyzeAdHocSpl), so the idiom the
 *    model copies is one it may run.
 * Rows of sourcetypes another add-on parses (linux_messages_syslog, linux_secure:
 * Splunk_TA_nix; XmlWinEventLog: Splunk_TA_windows) and the App-owned linux:*
 * names get M1, M2 and M5 only. The sap:abap:icm and sap:webdispatcher:access
 * rows keep their own pins as well (icmProps M1-M3, wdProps S5,
 * check-diagnostics 3icm (e)).
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
const sg = require('./splGuard');

const DEF = path.resolve(__dirname, '../../../../resources/splunk/default');
const CSV = path.resolve(DEF, '../lookups/logserv_sourcetype_metadata.csv');
// default -> ... -> sap_logserv_package (8 levels up), then the Data TA source beside the App (as wdProps R1).
const DATA_TA = path.resolve(DEF, '../../../../../../../../splunk_ta_sap_logserv/package/default/transforms.conf');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let smFailures = 0;
let smChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    smChecks += 1;
    if (!ok) {
        smFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

const stanzas = (text: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    let cur: string | null = null;
    text.split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            const [, name] = h;
            cur = name;
            if (!out[name]) {
                out[name] = [];
            }
            return;
        }
        if (cur !== null && line.trim() !== '' && !/^\s*#/.test(line)) {
            out[cur].push(line);
        }
    });
    return out;
};
const valueOf = (lines: string[], key: string): string | undefined => {
    const hit = lines.find((l) => new RegExp(`^${key}\\s*=`).test(l));
    return hit === undefined ? undefined : hit.slice(hit.indexOf('=') + 1).trim();
};
const groups = (re: string): string[] => (re.match(/\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g) || [])
    .map((g) => g.replace(/^\(\?P?</, '').replace(/>$/, ''));
/** The static names of a FORMAT (`name::$1 name2::"x"`); `$1::$2` gives none. */
const formatNames = (fmt: string): string[] => (fmt.match(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)::/g) || [])
    .map((x) => x.trim().replace(/::$/, ''));

/* ============================ the App's fields, per stanza ============================ */

const PROPS = stanzas(read(path.join(DEF, 'props.conf')));
const TRANS = stanzas(read(path.join(DEF, 'transforms.conf')));
const hasStanza = (st: string): boolean => Object.prototype.hasOwnProperty.call(PROPS, st);

const fieldsOf = (st: string): Set<string> => {
    const out = new Set<string>();
    (PROPS[st] || []).forEach((line) => {
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (/^EXTRACT-/.test(key)) {
            groups(val.replace(/\s+in\s+\w+$/, '')).forEach((g) => out.add(g));
        } else if (/^EVAL-/.test(key)) {
            out.add(key.slice(5));
        } else if (/^FIELDALIAS-/i.test(key)) {
            (val.match(/\bAS(?:NEW)?\s+(\S+)/gi) || []).forEach((a) => out.add(a.split(/\s+/)[1]));
        } else if (/^REPORT-/.test(key)) {
            val.split(',').map((t) => t.trim()).filter((t) => t).forEach((t) => {
                const tl = TRANS[t] || [];
                const fmt = valueOf(tl, 'FORMAT');
                if (fmt !== undefined) {
                    formatNames(fmt).forEach((n) => out.add(n));
                } else {
                    groups(valueOf(tl, 'REGEX') || '').forEach((g) => out.add(g));
                }
                (valueOf(tl, 'FIELDS') || '').split(/[\s,]+/).filter((f) => f).forEach((f) => out.add(f.replace(/"/g, '')));
            });
        } else if (/^LOOKUP-/.test(key)) {
            const outPart = val.split(/\bOUTPUT(?:NEW)?\b/i)[1] || '';
            outPart.split(',').forEach((x) => {
                const t = x.trim().split(/\s+/);
                const i = t.findIndex((w) => /^as$/i.test(w));
                if (t[0]) {
                    out.add(i >= 0 ? t[i + 1] : t[0]);
                }
            });
        }
    });
    return out;
};

/* ============================ what every event carries ============================ */

const INDEXED = new Set<string>(['host', 'source', 'sourcetype']);
const ROUTED = new Set<string>();
if (!fs.existsSync(DATA_TA)) {
    check('I0 the Data TA source is beside the App (its routes and WRITE_META fields are read from it)', false, DATA_TA);
} else {
    const ta = stanzas(read(DATA_TA));
    const written = new Set<string>();
    Object.keys(ta).forEach((name) => {
        const fmt = valueOf(ta[name], 'FORMAT') || '';
        const m = /^sourcetype::(\S+)$/.exec(fmt);
        if (m && valueOf(ta[name], 'DEST_KEY') === 'MetaData:Sourcetype') {
            ROUTED.add(m[1]);
        }
        if (/^true$/i.test(valueOf(ta[name], 'WRITE_META') || '')) {
            formatNames(fmt).forEach((n) => written.add(n));
            // `$1::$2` with a literal alternation as the first group (extract_clz): its names.
            const alt = /^\$1::/.test(fmt) ? /\(([A-Za-z_]\w*(?:\|[A-Za-z_]\w*)+)\)/.exec(valueOf(ta[name], 'REGEX') || '') : null;
            if (alt) {
                alt[1].split('|').forEach((n) => written.add(n));
            }
        }
    });
    const declared = Object.entries(stanzas(read(path.join(DEF, 'fields.conf'))))
        .filter(([, lines]) => /^true$/i.test(valueOf(lines, 'INDEXED') || '')).map(([n]) => n);
    declared.forEach((n) => {
        check(`I1 fields.conf's indexed field ${n} is written by a Data TA WRITE_META transform`, written.has(n),
            `written: ${Array.from(written).join(', ')}`);
        INDEXED.add(n);
    });
    check('I2 the Data TA routes were read', ROUTED.size >= 20, `${ROUTED.size} routed sourcetypes`);
}

/* ============================ the lookup, as shipped ============================ */

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

const RAW: string = fs.readFileSync(CSV, 'utf8');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;
check('M1 LF line endings, no other control character, a final newline',
    !CONTROL.test(RAW) && RAW.endsWith('\n') && RAW.charCodeAt(0) !== 0xfeff, 'CR, NUL, BOM or another control byte');
const LINES = RAW.split('\n').filter((l) => l !== '');
const HEAD = ['sourcetype', 'domain', 'description', 'key_fields', 'sample_spl'];
check('M1 the header', LINES.length > 1 && splitCsv(LINES[0]).join(',') === HEAD.join(','), LINES[0]);
check('M1 no row twice', new Set(LINES).size === LINES.length, 'a row repeats');

const OWN = /^(sap:|isc:bind:|squid:)/;
const MACRO = '`sap_logserv_idx_macro`';

/** Field names a sample reads: name=, name!=, name<, name>, name IN ( before the first pipe; by-lists; fn(name). */
const sampleFields = (spl: string): string[] => {
    const bare = spl.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const made = new Set<string>([
        ...groups(spl),
        ...(bare.match(/\bas\s+[A-Za-z_]\w*/gi) || []).map((x) => x.split(/\s+/)[1]),
        ...(bare.match(/\beval\s+[A-Za-z_]\w*\s*=/gi) || []).map((x) => x.replace(/^eval\s+/i, '').replace(/\s*=$/, '')),
    ]);
    const first = bare.split('|')[0].replace(MACRO, ' ');
    const names: string[] = [];
    (first.match(/\b[A-Za-z_]\w*\s*(?:!=|<=|>=|=|<|>)/g) || []).forEach((x) => names.push(x.replace(/\s*[!<>=]+$/, '')));
    (first.match(/\b[A-Za-z_]\w*\s+IN\s*\(/g) || []).forEach((x) => names.push(x.split(/\s+/)[0]));
    bare.split('|').slice(1).forEach((cmd) => {
        const by = /\bby\s+(.+)$/.exec(cmd);
        if (by) {
            by[1].split(/[\s,]+/).filter((x) => /^[A-Za-z_]\w*$/.test(x)).forEach((x) => names.push(x));
        }
        (cmd.match(/\b[a-z_0-9]+\(([A-Za-z_]\w*)\)/g) || []).forEach((x) => names.push(x.replace(/^.*\(/, '').replace(/\)$/, '')));
    });
    return names.filter((n, i) => names.indexOf(n) === i && !made.has(n));
};

LINES.slice(1).forEach((line, i) => {
    const row = splitCsv(line);
    const n = i + 1;
    check(`M1 row ${n} has five columns`, row.length === 5, line.slice(0, 80));
    if (row.length !== 5) {
        return;
    }
    const [st, , , keyFields, spl] = row;
    const keys = keyFields.split(' ');
    check(`M1 row ${n} (${st}) has 1 to 8 distinct key fields, one space apart`,
        keys.length >= 1 && keys.length <= 8 && keys.every((k) => /^[A-Za-z_]\w*$/.test(k)) && new Set(keys).size === keys.length,
        keyFields);
    check(`M2 row ${n}: ${st} is a sourcetype the pipeline produces`, ROUTED.has(st) || hasStanza(st),
        'no Data TA route writes it and the App has no props.conf stanza for it');
    check(`M5 row ${n} (${st}): the sample starts with the index macro`, spl.indexOf(`${MACRO} `) === 0, spl);
    const guard = sg.analyzeAdHocSpl(spl);
    check(`M5 row ${n} (${st}): the AI guard runs the sample`, !guard.blocked, `${guard.operator}: ${guard.reason}`);
    if (!OWN.test(st)) {
        return;
    }
    check(`M3 row ${n}: ${st} has a props.conf stanza`, hasStanza(st), st);
    const have = fieldsOf(st);
    const missing = keys.filter((k) => !have.has(k) && !INDEXED.has(k));
    check(`M3 row ${n} (${st}): every key field is extracted for it or indexed`, missing.length === 0,
        `not extracted by [${st}] nor indexed: ${missing.join(', ')}`);
    const used = sampleFields(spl).filter((k) => !have.has(k) && !INDEXED.has(k));
    check(`M4 row ${n} (${st}): every field the sample reads is extracted for it or indexed`, used.length === 0,
        `${used.join(', ')} in: ${spl}`);
});

/* ===================================================================== */

if (smFailures > 0) {
    process.stderr.write(`\nsourcetypeMetadata.consistency-test: ${smFailures} failure(s) of ${smChecks}\n`);
    process.exit(1);
}
console.log(`sourcetypeMetadata.consistency-test: OK (${smChecks} checks; ${LINES.length - 1} rows)`);
