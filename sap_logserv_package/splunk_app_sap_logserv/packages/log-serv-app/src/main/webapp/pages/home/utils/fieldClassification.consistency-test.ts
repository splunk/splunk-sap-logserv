/**
 * Build-time consistency test for utils/fieldClassification.ts (App build
 * 377, AI-a2-names option B): the exact class table of every field name the
 * App defines.
 *
 * What it pins:
 *  - A. COVERAGE: every field name the App's own files define has a class -
 *    default/props.conf (EXTRACT named groups, EVAL-<name>, FIELDALIAS
 *    targets, LOOKUP outputs), default/transforms.conf (REGEX named groups,
 *    FORMAT targets, fields_list), default/collections.conf (`field.<name>`)
 *    and the header of every lookups/*.csv. A new extraction, rollup column
 *    or lookup column cannot ship unclassified: the build fails here until it
 *    is added to FIELD_CLASSES. Read the way the build reads the files.
 *  - B. NO WEAKER THAN THE PATTERNS: a name the name patterns of
 *    utils/piiRedaction.ts mark is an `identifier` or an `address` in the
 *    table (a host name: `host` or stronger), so the table only ever adds.
 *  - C. THE SEMANTICS of isClassifiedIdentifier (identifier and address
 *    always, host only with the hostname opt-in, free_text and safe never)
 *    and exact-case lookup.
 *  - D. THE GAP LIST of build 376 (privacy-tiers docs) is closed: each of
 *    those names is an identifier to the Tier 2 reader.
 *  - E. ROLLUP COLUMNS (security review of build 377): every column of a
 *    lookup an ad-hoc query may read (`| inputlookup`) that a saved search
 *    writes (`outputlookup`) is classified no weaker than the fields whose
 *    VALUES its rollup search puts into it - derived from
 *    default/savedsearches.conf (eval assignments - only the value arms of
 *    case / if; a condition, a comparison or a hash carries no value -
 *    renames, and stats `fn(field) AS column`), so a rollup that starts
 *    writing a user name or an address into a `safe` column fails the build.
 *    Build 377 found four: `operator`, `error_detail`, `scope`,
 *    `spl_filter_clauses`. Also: the field names Splunk's automatic key-value
 *    extraction gives the LogServ Linux sourcetypes, and the Windows names,
 *    that the name patterns missed.
 *  - F. THE FIELDS OF BUILD 378 (SAP Router CONNECT TO targets, the gateway's
 *    connection records, the HANA audit client host `src_host`, the HANA trace
 *    rewrite) carry exactly the class the design gives them, so a later edit
 *    cannot weaken one quietly; `src_host` is redacted by default (the name
 *    pattern for CIM `src` / `src_host`, without the hostname opt-in) and
 *    `gw_remgw_target` - which no name pattern marks - is an identifier to
 *    the Tier 2 reader through the table alone. The client workstation
 *    names `audit_hostname` and `gw_client_hostname` are addresses (user
 *    decision for build 378): redacted without the hostname opt-in, while
 *    the database server's `db_hostname` stays a host (F7).
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
const fc = require('./fieldClassification');
const pii = require('./piiRedaction');
const vc = require('./vendorColumnText');
const sg = require('./splGuard');

const RES = path.resolve(__dirname, '../../../../resources/splunk');

let fcFailures = 0;
let fcChecks = 0;
const check = (name: string, cond: boolean, detail: string): void => {
    fcChecks += 1;
    if (!cond) {
        fcFailures += 1;
        process.stderr.write(`FAIL ${name}: ${detail}\n`);
    }
};

const read = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/* ============================ the App's field names ============================ */

const defined = new Map<string, Set<string>>();
const add = (n: string, src: string): void => {
    // Dynamic names (`_KEY_1::_VAL_1`) are not names.
    if (!n || /^_(?:KEY|VAL)_/.test(n)) return;
    if (!defined.has(n)) defined.set(n, new Set());
    (defined.get(n) as Set<string>).add(src);
};
const groupsOf = (re: string, src: string): void => {
    (re.match(/\(\?(?:P?<[A-Za-z_][A-Za-z0-9_]*>|'[A-Za-z_][A-Za-z0-9_]*')/g) || [])
        .forEach((g) => add(g.replace(/^\(\?P?[<']/, '').replace(/[>']$/, ''), src));
};

read(path.join(RES, 'default/props.conf')).split('\n').forEach((line) => {
    if (/^\s*#/.test(line)) return;
    let m = /^EXTRACT-[^=]*?\s*=\s*(.*)$/.exec(line);
    if (m) {
        groupsOf(m[1], 'props.conf EXTRACT');
        return;
    }
    m = /^EVAL-([^\s=]+)\s*=/.exec(line);
    if (m) {
        add(m[1], 'props.conf EVAL');
        return;
    }
    m = /^FIELDALIAS-[^=]*?\s*=\s*(.*)$/.exec(line);
    if (m) {
        const re = /\b(?:AS|ASNEW)\s+("[^"]+"|\S+)/gi;
        let a = re.exec(m[1]);
        while (a !== null) {
            add(a[1].replace(/"/g, ''), 'props.conf FIELDALIAS');
            a = re.exec(m[1]);
        }
        return;
    }
    m = /^LOOKUP-[^=]*?\s*=\s*(.*)$/.exec(line);
    if (m) {
        const out = m[1].split(/\bOUTPUT(?:NEW)?\b/i)[1] || '';
        out.split(',').forEach((x) => {
            const t = x.trim().split(/\s+/);
            if (!t[0]) return;
            const i = t.findIndex((w) => /^as$/i.test(w));
            add(i >= 0 ? t[i + 1] : t[0], 'props.conf LOOKUP');
        });
    }
});
read(path.join(RES, 'default/transforms.conf')).split('\n').forEach((line) => {
    if (/^\s*#/.test(line)) return;
    let m = /^REGEX\s*=\s*(.*)$/.exec(line);
    if (m) {
        groupsOf(m[1], 'transforms.conf REGEX');
        return;
    }
    m = /^FORMAT\s*=\s*(.*)$/.exec(line);
    if (m) {
        (m[1].match(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)::/g) || []).forEach((x) => add(x.trim().replace(/::$/, ''), 'transforms.conf FORMAT'));
        return;
    }
    m = /^fields_list\s*=\s*(.*)$/.exec(line);
    if (m) m[1].split(',').forEach((x) => add(x.trim(), 'transforms.conf fields_list'));
});
read(path.join(RES, 'default/collections.conf')).split('\n').forEach((line) => {
    const m = /^field\.([^\s=]+)\s*=/.exec(line);
    if (m) add(m[1], 'collections.conf');
});
const csvs: string[] = fs.readdirSync(path.join(RES, 'lookups')).filter((f: string) => f.endsWith('.csv'));
csvs.forEach((f) => {
    read(path.join(RES, 'lookups', f)).split('\n')[0].split(',').forEach((x) => add(x.trim().replace(/^"|"$/g, ''), `lookups/${f}`));
});

/* ============================ A. coverage ============================ */

const classes: string[] = Array.from(fc.FIELD_CLASS_NAMES);
check('A0 the five classes', JSON.stringify(classes) === '["identifier","address","host","free_text","safe"]', JSON.stringify(classes));
const badClass = Object.keys(fc.FIELD_CLASSES).concat(Object.keys(fc.SPLUNK_FIELD_CLASSES))
    .filter((n) => classes.indexOf(fc.fieldClassOf(n)) === -1);
check('A1 every entry has one of the five classes', badClass.length === 0, badClass.join(', '));
check('A2 the conf files were read', defined.size >= 400 && csvs.length >= 8, `${defined.size} names, ${csvs.length} csv files`);
const missing = Array.from(defined.keys()).filter((n) => fc.fieldClassOf(n) === undefined).sort();
check('A3 every field name the App defines has a class (add it to FIELD_CLASSES in utils/fieldClassification.ts)',
    missing.length === 0, missing.map((n) => `${n} (${Array.from(defined.get(n) as Set<string>).join('; ')})`).join(', '));
const overlap = Object.keys(fc.SPLUNK_FIELD_CLASSES).filter((n) => Object.prototype.hasOwnProperty.call(fc.FIELD_CLASSES, n));
check('A4 the Splunk table and the App table share no name', overlap.length === 0, overlap.join(', '));
check('A5 the tables are frozen', Object.isFrozen(fc.FIELD_CLASSES) && Object.isFrozen(fc.SPLUNK_FIELD_CLASSES), '');
// Names in the table that no App file defines any more (a dropped field) are listed, not failed.
const stale = Object.keys(fc.FIELD_CLASSES).filter((n) => !defined.has(n));

/* ============================ B. no weaker than the patterns ============================ */

const all = Object.keys(fc.FIELD_CLASSES).concat(Object.keys(fc.SPLUNK_FIELD_CLASSES));
const weaker = all.filter((n) => pii.isPiiColumn(n, { enabled: true }) && ['identifier', 'address'].indexOf(fc.fieldClassOf(n)) === -1);
check('B1 a name the patterns mark is an identifier or an address in the table', weaker.length === 0,
    weaker.map((n) => `${n}=${fc.fieldClassOf(n)}`).join(', '));
const hostWeaker = all.filter((n) => pii.isPiiColumn(n, { enabled: true, redactHostnames: true }) && !pii.isPiiColumn(n, { enabled: true })
    && ['identifier', 'address', 'host'].indexOf(fc.fieldClassOf(n)) === -1);
check('B2 a name the hostname pattern marks is a host or stronger', hostWeaker.length === 0,
    hostWeaker.map((n) => `${n}=${fc.fieldClassOf(n)}`).join(', '));

/* ============================ C. semantics ============================ */

const byClass = (c: string): string[] => all.filter((n) => fc.fieldClassOf(n) === c);
check('C1 identifier and address names are identifiers with or without the hostname opt-in',
    byClass('identifier').concat(byClass('address')).every((n) => fc.isClassifiedIdentifier(n, false) && fc.isClassifiedIdentifier(n, true)), '');
check('C2 host names are identifiers only with the hostname opt-in', byClass('host').length > 0
    && byClass('host').every((n) => !fc.isClassifiedIdentifier(n, false) && fc.isClassifiedIdentifier(n, true)), '');
check('C3 free text and safe names are never identifiers by the table', byClass('free_text').concat(byClass('safe'))
    .every((n) => !fc.isClassifiedIdentifier(n, false) && !fc.isClassifiedIdentifier(n, true)), '');
check('C4 the lookup is exact (case included); unknown names have no class', fc.fieldClassOf('FROM') === 'address'
    && fc.fieldClassOf('From') === undefined && fc.fieldClassOf('no_such_field_377') === undefined
    && fc.fieldClassOf('constructor') === undefined && fc.fieldClassOf('toString') === undefined
    && fc.fieldClassOf('__proto__') === undefined && fc.isClassifiedIdentifier('no_such_field_377', true) === false, '');

/* ============================ D. the build-376 gap list ============================ */

const GAP = ['object', 'identity', 'identities', 'local_ip', 'info_sid', 'user_name', 'FROM', 'sql_statement', 'command',
    'icm_local_ip', 'ssl_peer_ip', 'ssl_local_ip', 'remote_address', 'peer_address', 'local_address', 'peer_ip',
    'icm_peer_ip', 'ip', 'fw_dst', 'supplied_by', 'canonical_value', 'label', 'fetched_by', 'peer'];
const gapOpen = GAP.filter((n) => !vc.isIdentifierColumnName(n, {}));
check('D1 every name of the build-376 gap list is an identifier to the Tier 2 reader', gapOpen.length === 0, gapOpen.join(', '));
check('D2 Computer and the App\'s other host fields follow the hostname opt-in', ['Computer', 'host', 'db_hostname',
    'hana_host', 'syslog_host', 'sudo_host', 'scc_backend_host', 'source_host'].every((n) => !vc.isIdentifierColumnName(n, {})
    && vc.isIdentifierColumnName(n, { redactHostnames: true })), '');
check('D3 ordinary App fields stay readable', ['sap_sid', 'src_port', 'dest_port', 'user_agent', 'source', 'sourcetype', 'action',
    'status', 'uri', 'query', 'hana_trace_severity', 'cloud_provider', 'count'].every((n) => !vc.isIdentifierColumnName(n, {})), '');

/* ============================ E. rollup columns (security review of build 377) ============================ */

{
    const fieldsLists: Record<string, string[]> = {};
    let stanzaE: string | null = null;
    read(path.join(RES, 'default/transforms.conf')).split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            stanzaE = h[1];
            return;
        }
        const m = /^fields_list\s*=\s*(.*)$/.exec(line);
        if (m && stanzaE !== null) fieldsLists[stanzaE] = m[1].split(',').map((x) => x.trim());
    });
    const readable = new Set<string>(Array.from(sg.ALLOWED_SPL_LOOKUPS as string[]));
    const TOK = /"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_][A-Za-z0-9_.:]*|\d+(?:\.\d+)?|==|!=|<=|>=|\S/g;
    // Functions whose value carries none of their arguments' values: a test, a hash, a length, a time.
    const NO_FLOW = new Set<string>(['match', 'like', 'isnull', 'isnotnull', 'searchmatch', 'cidrmatch', 'isnum', 'isint',
        'isstr', 'isbool', 'in', 'len', 'sha1', 'sha256', 'sha512', 'md5', 'now', 'relative_time', 'time', 'random', 'null',
        'mvcount', 'typeof', 'true', 'false']);
    const BOOL_OPS = new Set<string>(['==', '!=', '<', '>', '<=', '>=', '=', 'AND', 'OR', 'NOT', 'XOR', 'LIKE']);
    const KEYWORDS = new Set<string>(['AND', 'OR', 'NOT', 'XOR', 'LIKE', 'true', 'false', 'null']);
    const isWordTok = (x: string): boolean => /^[A-Za-z_]/.test(x) && !KEYWORDS.has(x);
    const splitTop = (tk: string[], a: number, b: number, sep: (x: string) => boolean): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        let depth = 0;
        let s = a;
        for (let i = a; i < b; i += 1) {
            const x = tk[i];
            if (x === '(' || x === '[') depth += 1;
            else if (x === ')' || x === ']') depth -= 1;
            else if (depth === 0 && sep(x)) {
                out.push([s, i]);
                s = i + 1;
            }
        }
        out.push([s, b]);
        return out;
    };
    const closeAt = (tk: string[], open: number, b: number): number => {
        let depth = 0;
        for (let i = open; i < b; i += 1) {
            if (tk[i] === '(') depth += 1;
            else if (tk[i] === ')') {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return b - 1;
    };
    // The fields whose values may flow into the value of the expression tk[a, b) (fail closed: an expression
    // of an unknown shape carries every word in it).
    const flow = (tk: string[], a: number, b: number): string[] => {
        if (a >= b) return [];
        if (splitTop(tk, a, b, (x) => BOOL_OPS.has(x)).length > 1) return [];
        const parts = splitTop(tk, a, b, (x) => ['.', '+', '-', '*', '/', '%'].indexOf(x) !== -1);
        if (parts.length > 1) return ([] as string[]).concat(...parts.map(([x, y]) => flow(tk, x, y)));
        if (tk[a] === '(' && closeAt(tk, a, b) === b - 1) return flow(tk, a + 1, b - 1);
        if (/^[A-Za-z_]/.test(tk[a]) && tk[a + 1] === '(' && closeAt(tk, a + 1, b) === b - 1) {
            const f = tk[a].toLowerCase();
            const args = splitTop(tk, a + 2, b - 1, (x) => x === ',');
            if (NO_FLOW.has(f)) return [];
            const valueArgs = f === 'case' ? args.filter((_x, i) => i % 2 === 1) : f === 'if' ? args.slice(1) : args;
            return ([] as string[]).concat(...valueArgs.map(([x, y]) => flow(tk, x, y)));
        }
        if (b - a === 1) {
            if (isWordTok(tk[a])) return [tk[a]];
            return /^'.*'$/.test(tk[a]) ? [tk[a].slice(1, -1)] : [];
        }
        return tk.slice(a, b).filter(isWordTok);
    };
    const RANK: Record<string, number> = { safe: 0, free_text: 0, host: 1, address: 2, identifier: 2 };
    const needs = (f: string): number => (vc.isIdentifierColumnName(f, {}) ? 2 : vc.isIdentifierColumnName(f, { redactHostnames: true }) ? 1 : 0);
    const flows = new Map<string, Set<string>>();
    let rollups = 0;
    read(path.join(RES, 'default/savedsearches.conf')).split('\n').forEach((line) => {
        const m = /^search\s*=\s*(.*)$/.exec(line);
        if (!m) return;
        const targets: string[] = [];
        const ol = /\|\s*outputlookup\s+(?:[A-Za-z_]+=\S+\s+)*([A-Za-z0-9_]+)/g;
        let o = ol.exec(m[1]);
        while (o !== null) {
            if (readable.has(o[1]) && fieldsLists[o[1]]) targets.push(o[1]);
            o = ol.exec(m[1]);
        }
        if (targets.length === 0) return;
        rollups += 1;
        const cols = new Set<string>(([] as string[]).concat(...targets.map((lk) => fieldsLists[lk])));
        const tk: string[] = m[1].match(TOK) || [];
        const add = (col: string, srcs: string[]): void => {
            if (!cols.has(col)) return;
            if (!flows.has(col)) flows.set(col, new Set<string>());
            srcs.filter((s) => s !== col).forEach((s) => (flows.get(col) as Set<string>).add(s));
        };
        for (let i = 1; i < tk.length; i += 1) {
            if (tk[i - 1] !== '|' && tk[i - 1] !== '[') continue;
            const name = tk[i].toLowerCase();
            let e = i + 1;
            let depth = 0;
            for (; e < tk.length; e += 1) {
                if (tk[e] === '(') depth += 1;
                else if (tk[e] === ')') depth -= 1;
                else if (depth <= 0 && (tk[e] === '|' || tk[e] === '[' || tk[e] === ']')) break;
            }
            if (name === 'eval') {
                splitTop(tk, i + 1, e, (x) => x === ',').forEach(([x, y]) => {
                    if (tk[x + 1] === '=' && /^[A-Za-z_]/.test(tk[x])) add(tk[x], flow(tk, x + 2, y));
                });
            } else if (name === 'rename') {
                splitTop(tk, i + 1, e, (x) => x === ',').forEach(([x, y]) => {
                    if (y - x === 3 && /^as$/i.test(tk[x + 1])) add(tk[x + 2], [tk[x]]);
                });
            } else if (['stats', 'eventstats', 'streamstats', 'chart', 'timechart', 'tstats'].indexOf(name) !== -1) {
                for (let j = i + 1; j < e; j += 1) {
                    if (!/^as$/i.test(tk[j]) || tk[j - 1] !== ')') continue;
                    let k = j - 1;
                    let dd = 0;
                    for (; k > i; k -= 1) {
                        if (tk[k] === ')') dd += 1;
                        else if (tk[k] === '(') {
                            dd -= 1;
                            if (dd === 0) break;
                        }
                    }
                    const fn = (tk[k - 1] || '').toLowerCase();
                    add(tk[j + 1], /^(?:c|count|dc|distinct_count|estdc)$/.test(fn) ? [] : tk.slice(k + 1, j - 1).filter(isWordTok));
                }
            }
        }
    });
    const seen = (col: string, src: string): boolean => !!flows.get(col) && (flows.get(col) as Set<string>).has(src);
    check('E0 the derivation reads the rollup searches and sees their known flows', rollups >= 60
        && seen('operator', 'executing_user') && seen('operator', 'SubjectUserName') && seen('scope', 'peer_ip')
        && seen('error_detail', 'executing_user') && seen('spl_filter_clauses', 'clientip') && seen('value', 'sudo_user')
        && !seen('tag', 'canonical_value') && !seen('admin_action', 'sql_statement'),
    `${rollups} rollup searches; operator <- [${Array.from(flows.get('operator') || []).join(', ')}]`);
    const weakerE: string[] = [];
    flows.forEach((srcs, col) => {
        const need = Math.max(0, ...Array.from(srcs).map(needs));
        const cls = fc.fieldClassOf(col);
        if (need > (cls === undefined ? -1 : RANK[cls])) {
            weakerE.push(`${col}=${cls} <- [${Array.from(srcs).filter((s) => needs(s) > 0).join(', ')}]`);
        }
    });
    check('E1 no rollup column an ad-hoc query can read is weaker than what its rollup writes into it (classify it in'
        + ' utils/fieldClassification.ts)', weakerE.length === 0, weakerE.join('; '));
    const ROLLUP_377: Record<string, string> = { operator: 'identifier', error_detail: 'identifier', scope: 'address',
        spl_filter_clauses: 'address' };
    check('E2 the four rollup columns of the security review hold identifiers or addresses',
        Object.keys(ROLLUP_377).every((n) => fc.fieldClassOf(n) === ROLLUP_377[n] && vc.isIdentifierColumnName(n, {})), '');
    // Field names the LogServ sourcetypes carry that the App does not define: Splunk's automatic key-value
    // extraction on the Linux sourcetypes (pam, sudo), and the Windows event names.
    const RAW_IDS = ['rhost', 'ruser', 'logname', 'euid', 'PWD', 'COMMAND', 'IpAddress', 'IPAddress', 'MacAddress',
        'TargetUserSid', 'SubjectUserSid', 'LogonGuid', 'Account Name', 'accountname'];
    const RAW_HOSTS = ['WorkstationName', 'HostName', 'ComputerName', 'DnsHostName', 'Host Name', 'host_name'];
    const RAW_KEEP = ['sap_sid', 'hana_tenant_sid', 'address_count', 'IpAddressCount', 'Addresses_seen', 'hostname_count',
        'Host Name Count', 'workstation', 'Guidance', 'tty', 'TTY'];
    check('E3 the raw LogServ identifier names are identifiers', RAW_IDS.every((n) => vc.isIdentifierColumnName(n, {})),
        RAW_IDS.filter((n) => !vc.isIdentifierColumnName(n, {})).join(', '));
    check('E4 the raw LogServ host names follow the hostname opt-in', RAW_HOSTS.every((n) => !vc.isIdentifierColumnName(n, {})
        && vc.isIdentifierColumnName(n, { redactHostnames: true })), RAW_HOSTS.filter((n) => vc.isIdentifierColumnName(n, {})
        || !vc.isIdentifierColumnName(n, { redactHostnames: true })).join(', '));
    check('E5 their look-alikes stay readable', RAW_KEEP.every((n) => !vc.isIdentifierColumnName(n, { redactHostnames: true })),
        RAW_KEEP.filter((n) => vc.isIdentifierColumnName(n, { redactHostnames: true })).join(', '));
}

/* ============================ F. the fields of build 378 ============================ */

{
    const F378: Record<string, string> = {
        // e: the SAP Router CONNECT TO target and the failed server-side connection's target
        saprouter_target_addr: 'address', saprouter_target_ip: 'address', saprouter_fail_target_ip: 'address',
        saprouter_target_sid: 'safe', saprouter_target_service: 'safe', saprouter_target_role: 'safe',
        saprouter_target_instance: 'safe',
        // f: the gateway's connection records (remote gateway closed, RFC client disconnected) and the P= / L= ports
        gw_remgw_target: 'address', gw_client_ip: 'address', gw_client_hostname: 'address', gw_remgw_id: 'identifier',
        gw_client_id: 'identifier', gw_remgw_service: 'safe', gw_client_tp: 'safe', rfc_peer_port: 'safe',
        rfc_local_port: 'safe',
        // h1: the HANA audit client host (the search-time host is the HANA host again); its extraction
        // audit_hostname is an address too (user decision for build 378: a client workstation's name)
        src_host: 'address', audit_hostname: 'address',
        // i1: the HANA trace rewrite
        hana_backup_level: 'safe', hana_trace_file_type: 'safe', hana_op_duration: 'safe', hana_op_duration_unit: 'safe',
        hana_op: 'safe',
        // icm: the dev_icm session-list and trace fields (icm_status_code is gone: it was the SAP client)
        sap_client: 'safe', icm_severity: 'safe', icm_conn_role: 'safe', icm_user: 'identifier', icm_terminal: 'address',
    };
    const wrong378 = Object.keys(F378).filter((n) => fc.fieldClassOf(n) !== F378[n]);
    check('F1 the fields of build 378 carry the class the design gives them', wrong378.length === 0,
        wrong378.map((n) => `${n}=${fc.fieldClassOf(n)} (want ${F378[n]})`).join(', '));
    const ids378 = Object.keys(F378).filter((n) => F378[n] === 'address' || F378[n] === 'identifier');
    check('F2 their addresses and identifiers are identifiers to the Tier 2 reader without the hostname opt-in',
        ids378.every((n) => vc.isIdentifierColumnName(n, {})), ids378.filter((n) => !vc.isIdentifierColumnName(n, {})).join(', '));
    check('F3 src_host is redacted by default (the CIM src pattern)',
        pii.isPiiColumn('src_host', { enabled: true }) === true && pii.isPiiColumn('src_hosts', { enabled: true }) === true
        && pii.isPiiColumn('src_host', { enabled: false }) === false
        && pii.redactValueIfPII('src_host', 'dewdfm7096', { enabled: true }) !== 'dewdfm7096',
    `src_host -> ${pii.redactValueIfPII('src_host', 'dewdfm7096', { enabled: true })}`);
    check('F4 gw_remgw_target is an identifier through the table alone (no name pattern marks it)',
        pii.isPiiColumn('gw_remgw_target', { enabled: true, redactHostnames: true }) === false
        && vc.isIdentifierColumnName('gw_remgw_target', {}) === true, '');
    check('F6 icm_status_code is no longer a class (no App file defines it)',
        !Object.prototype.hasOwnProperty.call(fc.FIELD_CLASSES, 'icm_status_code'), '');
    const safe378 = Object.keys(F378).filter((n) => F378[n] === 'safe');
    check('F5 their categorical and numeric fields stay readable, with the hostname opt-in too',
        safe378.every((n) => !vc.isIdentifierColumnName(n, { redactHostnames: true })),
        safe378.filter((n) => vc.isIdentifierColumnName(n, { redactHostnames: true })).join(', '));
    // User decision for build 378 (integration report items 7 and 8): a client workstation's host name can
    // name the person who uses it, so audit_hostname (the HANA audit client, aliased as src_host) and
    // gw_client_hostname (the external RFC client) are addresses - identifiers to the Tier 2 reader without
    // the hostname opt-in. A server's host name stays a host: db_hostname (the HANA host the audit record
    // names) is redacted only with the opt-in.
    const CLIENT_WS = ['audit_hostname', 'gw_client_hostname'];
    check('F7 the client workstation names are addresses, redacted without the hostname opt-in; db_hostname stays a host',
        CLIENT_WS.every((n) => fc.fieldClassOf(n) === 'address' && fc.isClassifiedIdentifier(n, false)
            && vc.isIdentifierColumnName(n, {}))
        && fc.fieldClassOf('db_hostname') === 'host' && !vc.isIdentifierColumnName('db_hostname', {})
        && vc.isIdentifierColumnName('db_hostname', { redactHostnames: true }),
        CLIENT_WS.concat(['db_hostname']).map((n) => `${n}=${fc.fieldClassOf(n)} (Tier 2 without the opt-in: `
            + `${vc.isIdentifierColumnName(n, {}) ? 'redacted' : 'sent'})`).join(', '));
}

/* ===================================================================== */

if (fcFailures > 0) {
    process.stderr.write(`\nfieldClassification.consistency-test: ${fcFailures} failure(s) of ${fcChecks}\n`);
    process.exit(1);
}
console.log(
    `fieldClassification.consistency-test: OK (${fcChecks} checks; ${defined.size} App field names, every one classified;`
    + ` ${byClass('identifier').length} identifier, ${byClass('address').length} address, ${byClass('host').length} host;`
    + ` ${stale.length} table name(s) no App file defines any more${stale.length ? `: ${stale.join(', ')}` : ''})`,
);
