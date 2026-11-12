/**
 * Build-time consistency test for the global SID and Host filters (build 395).
 *
 * The cardinal rule: a panel must never show unfiltered numbers while a filter is
 * on. Most rollup metrics do not store `host`, so a read either takes a term its
 * stored rows can honour, or falls to its raw twin, or shows nothing and says why.
 *
 * What it pins:
 *  - F1: utils/filterCapability.ts equals the `stats ... by` of every aggregate;
 *  - F2: the splice, shape by shape, and that no filter leaves a query byte-identical;
 *  - F3: against the dashboards' real query maps, every raw read takes the host term
 *    at every macro, every rollup read takes a term or the whole query is unavailable,
 *    and the panels with no raw twin are exactly the known ones;
 *  - F4: the SID-to-host list on the shapes real systems log (session 163);
 *  - F5: the three saved searches and what the conventions require of them;
 *  - F6: the wiring: 18 dashboards go through the query maps, the Host-only pages
 *    name their service twice, useSearch dispatches nothing and useRoutedQuery goes
 *    raw for an unavailable query;
 *  - F7: Data Doctor explains it, and does not call the filter's terms a grain filter;
 *  - F11: every click through to Splunk Search carries the page's filters.
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
declare const process: {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

const fs = require('fs');
const path = require('path');
const { ROLLUP_FILTER_FIELDS, NO_METRIC } = require('./filterCapability');
const {
    FILTER_UNAVAILABLE_SPL,
    isFilterUnavailable,
    withSidHostTerms,
    hostTerm,
    sapSidTerm,
    termsOf,
    rowsAreStale,
    HOST_OUTSIDE_SID,
    ownHostsInScope,
    picksCameFromOutside,
} = require('./queryFilters');
const { buildSidHostMap, describeHost, findSid, isSidName, scopeOf } = require('./sidHostMap');
const { allFreeVerdicts, explainEmptyPanel } = require('./panelDiagnosis');
const { probeSpl } = require('./splProbe');
const { FIXED30_BACKFILL_STANZAS, ROLLUPS } = require('../routes/rollupRegistry');

const HOME = path.resolve(__dirname, '..');
const RES = path.resolve(__dirname, '../../../../resources/splunk');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let qfFailures = 0;
let qfChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    qfChecks += 1;
    if (!ok) {
        qfFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};
const same = (a: string[], b: string[]): boolean => a.slice().sort().join('|') === b.slice().sort().join('|');

const MACRO = '`sap_logserv_idx_macro`';
const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const DAY_RANGE = '| addinfo | where day_ts>=info_min_time AND day_ts<info_max_time';
const BOTH = { hosts: ['h1', 'h2'], sids: ['XCP'] };
const HOSTS_ONLY = { hosts: ['h1', 'h2'], sids: [] };
const OR2 = '(host="h1" OR host="h2")';

/* ---- F1 the table equals the aggregates ---- */

const SAVED = read(path.join(RES, 'default', 'savedsearches.conf'));
const stanzas: { [name: string]: string } = {};
{
    let cur: string | null = null;
    SAVED.split('\n').forEach((line) => {
        const h = /^\[([^\]]+)\]\s*$/.exec(line);
        if (h) cur = h[1];
        else if (cur && line.startsWith('search = ') && stanzas[cur] === undefined) stanzas[cur] = line.slice('search = '.length);
    });
}
const armsOf = (spl: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < spl.length; i += 1) {
        if (spl[i] === '[') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (spl[i] === ']') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                out.push(spl.slice(start + 1, i));
                start = -1;
            }
        }
    }
    return out.length > 0 ? out : [spl];
};
const byFields = (arm: string): string[] => {
    const out: string[] = [];
    const re = /\b(?:tstats|stats)\b.*?\bby\s+([^|\]]+)/gi;
    let m = re.exec(arm);
    while (m) {
        (m[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).forEach((f: string) => out.push(f));
        m = re.exec(arm);
    }
    return out;
};
const actual: { [c: string]: { host: string[]; sapSid: string[]; metrics: string[] } } = {};
Object.keys(stanzas).filter((n) => n.endsWith('_aggregate')).forEach((name) => {
    const t = /outputlookup[^|]*?\b(logserv_[a-z0-9_]+)/.exec(stanzas[name]);
    if (!t) return;
    const col = t[1];
    const slot = actual[col] || (actual[col] = { host: [], sapSid: [], metrics: [] });
    armsOf(stanzas[name]).forEach((arm) => {
        const ms: string[] = [];
        const mre = /metric\s*=\s*"([A-Za-z0-9_]+)"/g;
        let m = mre.exec(arm);
        while (m) {
            ms.push(m[1]);
            m = mre.exec(arm);
        }
        const bf = byFields(arm);
        (ms.length > 0 ? ms : [NO_METRIC]).forEach((x: string) => {
            if (slot.metrics.indexOf(x) === -1) slot.metrics.push(x);
            if (bf.indexOf('host') !== -1 && slot.host.indexOf(x) === -1) slot.host.push(x);
            if (bf.indexOf('sap_sid') !== -1 && slot.sapSid.indexOf(x) === -1) slot.sapSid.push(x);
        });
    });
});
Object.keys(ROLLUP_FILTER_FIELDS).forEach((c) => {
    const a = actual[c];
    check(`F1 ${c} has an aggregate`, !!a, 'no *_aggregate writes it');
    if (!a) return;
    const f = ROLLUP_FILTER_FIELDS[c];
    check(`F1 ${c}: the metrics that store host`, same(a.host, f.host as string[]), `conf ${a.host} table ${f.host}`);
    check(`F1 ${c}: the metrics that store sap_sid`, same(a.sapSid, f.sapSid as string[]), `conf ${a.sapSid} table ${f.sapSid}`);
});

/* ---- F2 the splice, shape by shape ---- */

const hostRead = `| inputlookup logserv_windows_rollup where metric="main" ${RANGE} | stats count`;
const sidRead = `| inputlookup logserv_wp_perf_rollup where metric="wp" ${RANGE} | stats count`;
const bothRead = `| inputlookup logserv_wp_perf_rollup where metric="wperr" ${RANGE} | stats count`;
const neitherRead = `| inputlookup logserv_proxy_rollup where metric="core" ${RANGE} | stats count`;
const rawRead = `${MACRO} sourcetype="x" | stats count`;
const tstatsRead = `| tstats count WHERE ${MACRO} BY host`;

[hostRead, sidRead, neitherRead, rawRead, tstatsRead, FILTER_UNAVAILABLE_SPL].forEach((q, i) => {
    check(`F2a no filter leaves shape ${i} byte-identical`, withSidHostTerms(q, null) === q, q);
    check(`F2b empty terms leave shape ${i} byte-identical`, withSidHostTerms(q, { hosts: [], sids: [] }) === q, q);
});
check('F2c a metric that stores host takes the host term after the range',
    withSidHostTerms(hostRead, BOTH) === `| inputlookup logserv_windows_rollup where metric="main" ${RANGE} | search ${OR2} | stats count`,
    withSidHostTerms(hostRead, BOTH));
check('F2d one host takes the plain form', hostTerm(['h1']) === 'host="h1"', hostTerm(['h1']));
check('F2e a host name is escaped', hostTerm(['a"b\\c']) === 'host="a\\"b\\\\c"', hostTerm(['a"b\\c']));
check('F2f a metric that stores only sap_sid takes the SID term while a SID is selected',
    withSidHostTerms(sidRead, BOTH) === `| inputlookup logserv_wp_perf_rollup where metric="wp" ${RANGE} | search (sap_sid="XCP") | stats count`,
    withSidHostTerms(sidRead, BOTH));
check('F2g hosts picked by hand cannot use sap_sid: the read is unavailable',
    isFilterUnavailable(withSidHostTerms(sidRead, HOSTS_ONLY)), withSidHostTerms(sidRead, HOSTS_ONLY));
check('F2h a metric that stores both prefers host', withSidHostTerms(bothRead, BOTH).indexOf(`| search ${OR2}`) !== -1, withSidHostTerms(bothRead, BOTH));
check('F2i a metric that stores neither is unavailable', isFilterUnavailable(withSidHostTerms(neitherRead, BOTH)), withSidHostTerms(neitherRead, BOTH));
check('F2j an unknown collection is unavailable',
    isFilterUnavailable(withSidHostTerms(`| inputlookup logserv_new_rollup where metric="m" ${RANGE}`, BOTH)), 'unknown collection');
check('F2k an unknown metric is unavailable',
    isFilterUnavailable(withSidHostTerms(`| inputlookup logserv_windows_rollup where metric="new" ${RANGE}`, BOTH)), 'unknown metric');
check('F2l a read with no range filter is unavailable',
    isFilterUnavailable(withSidHostTerms('| inputlookup logserv_windows_rollup where metric="main" | stats count', BOTH)), 'no range');
check('F2m a day-grain read with no stored field is unavailable',
    isFilterUnavailable(withSidHostTerms(`| inputlookup logserv_beaconing_rollup ${DAY_RANGE} | stats count`, BOTH)), 'beaconing');
const twoReads = `${hostRead} | append [${neitherRead}]`;
check('F2n one unfilterable read makes the whole query unavailable',
    isFilterUnavailable(withSidHostTerms(twoReads, BOTH)), withSidHostTerms(twoReads, BOTH));
const twoGood = `${hostRead} | append [| inputlookup logserv_linux_rollup where metric="fw" ${RANGE}]`;
check('F2o two filterable reads both take the term',
    (withSidHostTerms(twoGood, BOTH).match(/\| search \(host="h1" OR host="h2"\)/g) || []).length === 2, withSidHostTerms(twoGood, BOTH));
check('F2p a raw read takes the host term after the macro',
    withSidHostTerms(rawRead, BOTH) === `${MACRO} ${OR2} sourcetype="x" | stats count`, withSidHostTerms(rawRead, BOTH));
check('F2q a tstats read takes the host term inside WHERE',
    withSidHostTerms(tstatsRead, BOTH) === `| tstats count WHERE ${MACRO} ${OR2} BY host`, withSidHostTerms(tstatsRead, BOTH));
check('F2r every macro takes the term',
    (withSidHostTerms(`${rawRead} | append [search ${rawRead}]`, BOTH).match(/idx_macro` \(host=/g) || []).length === 2, 'two macros');
check('F2s the compound form matches a monitoring value on the Linux rollup',
    withSidHostTerms(`| inputlookup logserv_linux_rollup where metric="sapapp" ${RANGE}`, { hosts: ['h1'], sids: ['A44'] })
        .indexOf('| search (sap_sid="A44" OR sap_sid="A44_*")') !== -1, 'sapapp');
check('F2t no compound form elsewhere', sapSidTerm(['A44', 'A43'], false) === '(sap_sid="A44" OR sap_sid="A43")', sapSidTerm(['A44', 'A43'], false));
check('F2u an unavailable query stays unavailable', withSidHostTerms(FILTER_UNAVAILABLE_SPL, BOTH) === FILTER_UNAVAILABLE_SPL, 'marker');
check('F2v the marker is a valid search with no rows and no index read',
    /^\| makeresults \| where 1=0/.test(FILTER_UNAVAILABLE_SPL) && FILTER_UNAVAILABLE_SPL.indexOf('inputlookup') === -1
    && FILTER_UNAVAILABLE_SPL.indexOf(MACRO) === -1, FILTER_UNAVAILABLE_SPL);
check('F2w only the exact marker counts', !isFilterUnavailable('| makeresults') && !isFilterUnavailable('') && !isFilterUnavailable(undefined), 'isFilterUnavailable');
check('F2x a hand-picked host wins, with no SIDs',
    same(termsOf({ sid: 'XCP', hosts: ['h9'], scopeHosts: ['h1'], scopeSids: ['XCP'] }).hosts, ['h9'])
    && termsOf({ sid: 'XCP', hosts: ['h9'], scopeHosts: ['h1'], scopeSids: ['XCP'] }).sids.length === 0, 'termsOf');
check('F2y a SID stands for its scope',
    same(termsOf({ sid: 'A43', hosts: [], scopeHosts: ['h1', 'db'], scopeSids: ['A43', 'A44'] }).sids, ['A43', 'A44']), 'termsOf');
check('F2z nothing selected is no filter', termsOf({ sid: null, hosts: [], scopeHosts: [], scopeSids: [] }) === null, 'termsOf');
check('F2z1 a query that reads neither a rollup nor the index fails closed',
    isFilterUnavailable(withSidHostTerms('| rest /services/server/info', BOTH)), withSidHostTerms('| rest /services/server/info', BOTH));
check('F2z2 a SID that expands to nothing is no filter', termsOf({ sid: 'XCP', hosts: [], scopeHosts: [], scopeSids: ['XCP'] }) === null, 'termsOf');

/* ---- F3 the dashboards' real query maps ---- */

const SID_PAGES = ['AbapOperations', 'AbapSecurity', 'ChangeConfig', 'CrossStackAuthentication', 'EnvironmentHealth', 'HanaAudit',
    'HanaTrace', 'Linux', 'NetworkPerimeter', 'SapServices', 'WebApiPerformance', 'WebDispatcher', 'Windows', 'WorkProcessPerformance'];
const SERVICES: { [page: string]: string } = { SapRouter: 'saprouter', Proxy: 'proxy', DnsAnalytics: 'dns', CloudConnector: 'cloudconnector' };
const MAP_PAGES = SID_PAGES.concat(Object.keys(SERVICES));

const blockOf = (src: string, name: string): string => {
    const m = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
    if (!m) return '';
    let depth = 0;
    let tpl = false;
    for (let j = m.index + m[0].length - 1; j < src.length; j += 1) {
        const c = src[j];
        if (c === '\\') j += 1;
        else if (c === '`') tpl = !tpl;
        else if (!tpl && c === '{') depth += 1;
        else if (!tpl && c === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(m.index + m[0].length - 1, j);
        }
    }
    return '';
};
const unescapeTpl = (t: string): string => t.replace(/\\`/g, '`');
const entriesOf = (block: string): { [k: string]: string } => {
    const out: { [k: string]: string } = {};
    const re = /^\s{2,8}([A-Za-z_0-9]+):\s*(?:`((?:[^`\\]|\\[\s\S])*)`|'([^']*)')/gm;
    let m = re.exec(block);
    while (m) {
        out[m[1]] = m[2] !== undefined ? unescapeTpl(m[2]) : m[3];
        m = re.exec(block);
    }
    return out;
};

let rawTested = 0;
let cachedTested = 0;
const noTwin: string[] = [];
const neither: string[] = [];
MAP_PAGES.forEach((page) => {
    const src = read(path.join(HOME, 'dashboards', `${page}.tsx`));
    const consts: { [k: string]: string } = {};
    let cm: RegExpExecArray | null;
    const cre = /const\s+([A-Za-z_0-9]+)\s*=\s*(?:`((?:[^`\\]|\\[\s\S])*)`|'([^']*)')/g;
    while ((cm = cre.exec(src)) !== null) consts[cm[1]] = cm[2] !== undefined ? unescapeTpl(cm[2]) : cm[3];
    const expand = (v: string): string => {
        let out = v;
        for (let i = 0; i < 5; i += 1) out = out.replace(/\$\{([A-Za-z_0-9]+)\}/g, (_m, k: string) => (consts[k] !== undefined ? consts[k] : ''));
        return out;
    };

    // Every rollup this page names must be in the table, or a read of it is never filterable by accident.
    (src.match(/\blogserv_[a-z0-9_]+_rollup\b/g) || []).forEach((c: string) => {
        check(`F3a ${page} reads ${c}, which the table knows`, ROLLUP_FILTER_FIELDS[c] !== undefined, c);
    });

    const cached = entriesOf(blockOf(src, 'Q_BASE'));
    const raw = entriesOf(blockOf(src, 'QRAW_BASE'));
    Object.keys(raw).forEach((k) => {
        rawTested += 1;
        const q = expand(raw[k]);
        check(`F3b ${page}.${k} raw identity with no filter`, withSidHostTerms(q, null) === q, q);
        const f = withSidHostTerms(q, HOSTS_ONLY);
        check(`F3c ${page}.${k} a raw twin can always take the filter`, !isFilterUnavailable(f), q);
        const macros = (q.match(/`sap_logserv_idx_macro`/g) || []).length;
        check(`F3d ${page}.${k} every macro takes the host term`, macros === 0 || (f.match(/idx_macro` \(host=/g) || []).length === macros, f);
    });
    Object.keys(cached).forEach((k) => {
        const q = expand(cached[k]);
        if (q.indexOf('inputlookup') === -1 && q.indexOf(MACRO) === -1) neither.push(`${page}.${k}`);
        cachedTested += 1;
        check(`F3e ${page}.${k} identity with no filter`, withSidHostTerms(q, null) === q, q);
        [BOTH, HOSTS_ONLY].forEach((terms, i) => {
            const f = withSidHostTerms(q, terms);
            if (isFilterUnavailable(f)) return;
            const reads = (q.match(/inputlookup/g) || []).length;
            const macros = (q.match(/`sap_logserv_idx_macro`/g) || []).length;
            const searches = (f.match(/info_max_time \| search \((?:host|sap_sid)=|info_max_time \| search host=/g) || []).length;
            check(`F3f ${page}.${k} terms ${i}: every rollup read takes a term`, searches === reads, f);
            check(`F3g ${page}.${k} terms ${i}: every macro takes the host term`, macros === 0 || (f.match(/idx_macro` \(host=/g) || []).length === macros, f);
        });
        if (isFilterUnavailable(withSidHostTerms(q, HOSTS_ONLY)) && raw[k] === undefined && !/^spark/i.test(k)) noTwin.push(`${page}.${k}`);
    });
});
check('F3k every query reads a rollup or the index', neither.length === 0, neither.join(', '));
check('F3h the query maps were found', rawTested >= 150 && cachedTested >= 200, `raw ${rawTested}, cached ${cachedTested}`);
// The panels that show nothing under a filter, besides the sparklines. A new one
// must be a decision, not an accident. All are beaconing: its daily rollup keeps no
// host, and it cannot run raw at scale.
const EXPECTED_NO_TWIN = [
    'DnsAnalytics.beaconingActivity', 'DnsAnalytics.hostsToBeaconing', 'DnsAnalytics.kpiBeaconing',
    'EnvironmentHealth.beaconing',
    'NetworkPerimeter.kpiBeacon', 'NetworkPerimeter.suspicious',
];
check('F3i the panels with no raw twin are the known ones', same(noTwin, EXPECTED_NO_TWIN), noTwin.join(', '));

/* ---- F4 the SID-to-host list, on the shapes real systems log ---- */

const row = (sid: string, host: string, role: string, tenant = '(none)') => ({ sid, host, role, tenant });
const map = buildSidHostMap([
    // An application system on four hosts, from monitoring lines.
    row('A43', 'cs1', 'ABAP_CS'), row('A43', 'cs1', 'PACEMAKER_CS'), row('A43', 'ers1', 'ABAP_ERS'),
    row('A43', 'ai1', 'ABAP_AI'), row('A43', 'ai2', 'ABAP_AI'),
    // Its HANA database: --sid A44 and --sid A44_A43.
    row('A44', 'db1', 'HANA_MASTER_P'), row('A44', 'db2', 'HANA_MASTER_R'), row('A44', 'db1', 'HANA_X_MDC', 'A43'),
    // Disaster recovery hosts of a system.
    row('A62', 'dr1', 'DR_SYSTEM'),
    // Supporting services: not systems, and they must not tie a host to anything.
    row('SBD', 'sbd1', 'PACEMAKER_SBD'), row('GWC', 'gw1', 'GWC'), row('CGS', 'xcq1', 'CGS_STB'), row('CGS', 'xcq1', 'ICINGA_PROXY'),
    row('SIN', 'xcd1', 'SHA_CERT'), row('JJ3', 'hcc1', 'HEC_HCC'),
    // A host's own log paths, with a certificate check beside them.
    row('XCQ', 'xcq1', 'D00'), row('XCD', 'xcd1', 'D00'),
    // A Web Dispatcher SID on a host that also runs an application system: two real systems.
    row('XCP', 'wd1', 'D00'), row('W3V', 'wd1', 'WEBDISPATCHER'), row('W3V', 'wd1', 'SHA_CERT'),
    // A tenant whose application system logged nothing here.
    row('XCJ', 'jdb', 'HANA', 'XCI'),
    // A row with no role is still evidence.
    row('XHQ', 'hq1', '(none)'),
    // Junk the search should not write, ignored if it does.
    row('', 'x', 'D00'), row('Y1Z', '', 'D00'),
]);
const sidNames = map.sids.map((e: any) => e.sid);
['SBD', 'GWC', 'CGS', 'SIN', 'JJ3'].forEach((s) => check(`F4a ${s} is not listed as a system`, sidNames.indexOf(s) === -1, sidNames.join(',')));
['A43', 'A44', 'A62', 'XCQ', 'XCD', 'XCP', 'W3V', 'XCI', 'XCJ', 'XHQ'].forEach((s) => check(`F4b ${s} is listed`, sidNames.indexOf(s) !== -1, sidNames.join(',')));
check('F4c sorted', sidNames.join(',') === sidNames.slice().sort().join(','), sidNames.join(','));
const a43 = findSid(map, 'A43');
check('F4d A43 has its own four hosts and its database two', same(a43.hosts.map((h: any) => h.host), ['cs1', 'ers1', 'ai1', 'ai2', 'db1', 'db2']), a43.hosts.map((h: any) => h.host).join(','));
check('F4e own hosts first', a43.hosts.slice(0, 4).every((h: any) => !h.database) && a43.hosts.slice(4).every((h: any) => h.database === 'A44'), JSON.stringify(a43.hosts));
check('F4f the role is kept', a43.hosts.find((h: any) => h.host === 'cs1').roles.join(',') === 'ABAP_CS,PACEMAKER_CS', JSON.stringify(a43.hosts));
check('F4g A43 links its database', a43.databases.join(',') === 'A44', a43.databases.join(','));
check('F4h the scope has both', same(scopeOf(a43).scopeSids, ['A43', 'A44']) && scopeOf(a43).scopeHosts.length === 6, JSON.stringify(scopeOf(a43)));
check('F4i the database itself does not take the application hosts', same(findSid(map, 'A44').hosts.map((h: any) => h.host), ['db1', 'db2']), 'A44');
check('F4j a disaster recovery host belongs to the SID', describeHost(findSid(map, 'A62').hosts[0]) === 'DR_SYSTEM', 'A62');
check('F4k a database host says so', describeHost(a43.hosts.find((h: any) => h.host === 'db2')) === 'database A44 · HANA_MASTER_R', 'db2');
check('F4l a host keeps both real systems', findSid(map, 'XCP').hosts[0].host === 'wd1' && findSid(map, 'W3V').hosts[0].host === 'wd1', 'wd1');
check('F4m a non-system role is not shown beside a real one', findSid(map, 'W3V').hosts[0].roles.join(',') === 'WEBDISPATCHER', 'W3V');
check('F4n a certificate check does not move a host', findSid(map, 'XCD').hosts.length === 1 && findSid(map, 'XCQ').hosts.length === 1, 'xcd1, xcq1');
check('F4o a tenant with no hosts of its own gets its database', findSid(map, 'XCI').hosts[0].host === 'jdb' && findSid(map, 'XCI').hosts[0].database === 'XCJ', 'XCI');
check('F4p no role is still a host', findSid(map, 'XHQ').hosts[0].roles.length === 0 && describeHost(findSid(map, 'XHQ').hosts[0]) === '', 'XHQ');
check('F4q the Host filter lists every host of a system, and no supporting-service host',
    map.hosts.map((h: any) => h.host).indexOf('sbd1') === -1 && map.hosts.map((h: any) => h.host).indexOf('cs1') !== -1, 'hosts');
check('F4r a tenant equal to its own system links nothing', buildSidHostMap([row('A44', 'db1', 'HANA', 'A44')]).sids[0].databases.length === 0, 'self tenant');
check('F4s a supporting-service row names no tenant', findSid(buildSidHostMap([row('A1X', 'h', 'SHA_CERT', 'T1X')]), 'T1X') === null, 'non-system tenant');
check('F4v a database name that is no SID links nothing',
    findSid(buildSidHostMap([row('A44', 'db1', 'HANA', 'TENANT1'), row('A44', 'db1', 'HANA', '*')]), 'A44').databases.length === 0
    && buildSidHostMap([row('A44', 'db1', 'HANA', 'TENANT1'), row('A44', 'db1', 'HANA', '*')]).sids.length === 1, 'tenant shape');
check('F4w a SID name', isSidName('A44') && isSidName('J1S') && !isSidName('1AB') && !isSidName('A4') && !isSidName('A44_A43') && !isSidName('*AB') && !isSidName(''), 'isSidName');
check('F4t an empty list', buildSidHostMap([]).sids.length === 0, 'empty');
check('F4u findSid with nothing selected', findSid(map, null) === null, 'null');

/* ---- F5 the saved searches ---- */

const AGG = stanzas.logserv_sid_hosts_aggregate || '';
const BACK = stanzas.logserv_sid_hosts_backfill || '';
const RET = stanzas.logserv_sid_hosts_retention || '';
check('F5a the backfill runs what the hourly search runs', !!AGG && AGG === BACK, 'aggregate vs backfill');
check('F5b single-pipeline: no union or subsearch can drop rows', !/\bunion\b|\[/.test(AGG.replace(/\[A-Z(?:0-9)?\]|\[A-Z0-9\]/g, '')), AGG);
check('F5c it upserts', /\| outputlookup append=true logserv_sid_hosts$/.test(AGG), AGG);
check('F5d the key is built from the whole grain', AGG.indexOf('sha1(sid.":".host.":".role.":".tenant)') !== -1, AGG);
check('F5e role and tenant cannot be null, or stats would drop the row',
    AGG.indexOf(',"(none)"))') !== -1 && AGG.indexOf('true(),"(none)")') !== -1, AGG);
check('F5f no strftime', AGG.indexOf('strftime(') === -1, AGG);
check('F5g no dollar sign that could read as a token', AGG.indexOf('$') === -1, AGG);
check('F5h calls cannot reach it', !/\b(peer_ip|client_ip|clientip|saprouter_target_sid|gw_remote_host)\b/.test(AGG), AGG);
check('F5i the retention keeps a non-empty guard', /\| outputlookup override_if_empty=false logserv_sid_hosts \|/.test(RET), RET);
check('F5j the retention trims on last_seen', RET.indexOf('where last_seen >= relative_time(now(), "-365d")') !== -1, RET);
const stanzaBody = (name: string): string => {
    const i = SAVED.indexOf(`[${name}]`);
    const j = SAVED.indexOf('\n[', i + 1);
    return SAVED.slice(i, j === -1 ? undefined : j);
};
check('F5k the hourly search skips the aggregate and nightly bands',
    /cron_schedule = 38 3-23 \* \* \*/.test(stanzaBody('logserv_sid_hosts_aggregate')), stanzaBody('logserv_sid_hosts_aggregate'));
check('F5l the backfill is not scheduled', /enableSched = 0/.test(stanzaBody('logserv_sid_hosts_backfill')), stanzaBody('logserv_sid_hosts_backfill'));
check('F5m the backfill is pinned to its fixed window', FIXED30_BACKFILL_STANZAS.has('logserv_sid_hosts_backfill'), 'FIXED30');
const graph = ROLLUPS.find((r: any) => r.key === 'topology_graph');
check('F5n the registry row carries all of it',
    graph.collections.indexOf('logserv_sid_hosts') !== -1 && graph.aggregateSearches.indexOf('logserv_sid_hosts_aggregate') !== -1
    && graph.backfillStanzas.indexOf('logserv_sid_hosts_backfill') !== -1 && graph.retentionSearches.indexOf('logserv_sid_hosts_retention') !== -1,
    JSON.stringify(graph));
check('F5o it never gates the row on history', graph.completenessCollections.indexOf('logserv_sid_hosts') === -1, 'completeness');
const TRANSFORMS = read(path.join(RES, 'default', 'transforms.conf'));
check('F5p the lookup carries every stored field',
    TRANSFORMS.indexOf('fields_list = _key, sid, host, role, tenant, last_seen, updated_at') !== -1, 'transforms.conf');
const PROVIDER = read(path.join(HOME, 'state', 'SidHostFilterProvider.tsx'));
check('F5q the provider reads the list and the fields the list needs',
    PROVIDER.indexOf('\'| inputlookup logserv_sid_hosts | where last_seen >= relative_time(now(), "-90d") | fields sid, host, role, tenant\'') !== -1, 'MAP_QUERY');

/* ---- F6 the wiring ---- */

MAP_PAGES.forEach((page) => {
    const src = read(path.join(HOME, 'dashboards', `${page}.tsx`));
    const service = SERVICES[page];
    check(`F6a ${page} takes the filters from the provider`, src.indexOf("from '../state/SidHostFilterProvider'") !== -1, page);
    check(`F6b ${page} no longer applies the Cloud filter alone`,
        !/\b(useCloudProvider|mapCloudProviderQueries|withCloudProvider)\(/.test(src) && src.indexOf('CloudProviderProvider') === -1, page);
    const hooks = src.match(/useQueryFilters\([^)]*\)/g) || [];
    const want = service ? `useQueryFilters('${service}')` : 'useQueryFilters()';
    check(`F6c ${page} asks for its own scope`, hooks.length > 0 && hooks.every((h: string) => h === want), hooks.join(' '));
    const layouts = src.match(/<DashboardLayout\b[^>]*/g) || [];
    check(`F6d ${page} has a layout`, layouts.length > 0, page);
    layouts.forEach((l: string) => {
        check(`F6e ${page}'s layout agrees on the service`,
            service ? l.indexOf(`hostFilterService="${service}"`) !== -1 : l.indexOf('hostFilterService') === -1, l);
        check(`F6f ${page} stays on the filter strip`, l.indexOf('noCloudFilter') === -1, l);
    });
});
// A chart that chooses rollup or raw itself must also go raw for an unavailable rollup
// read, or it shows nothing while a raw arm that could honour the filter sits beside it.
MAP_PAGES.forEach((page) => {
    const src = read(path.join(HOME, 'dashboards', `${page}.tsx`));
    const chosen = (src.match(/\buseRawSrc\s*\?/g) || []).length;
    check(`F6q ${page} has no chart that chooses by the time range alone`, chosen === 0, `${chosen} useRawSrc ? ...`);
    const guarded = (src.match(/return useRawSrc \|\| isFilterUnavailable\(cachedQ\) \? rawQ : cachedQ;/g) || []).length;
    check(`F6r ${page} guards the charts that choose themselves`,
        guarded === (page === 'DnsAnalytics' || page === 'WebDispatcher' ? 2 : 0), String(guarded));
});
['HostDetails', 'DataPipelineOverview'].forEach((page) => {
    const src = read(path.join(HOME, 'dashboards', `${page}.tsx`));
    check(`F6g ${page} keeps its own picker inside the SID`, src.indexOf('ownHostPicker') !== -1 && src.indexOf('useSidScope()') !== -1, page);
    check(`F6g2 ${page}'s tabs get the hosts inside the SID, never the bare picks`,
        (src.match(page === 'HostDetails' ? /hosts=\{effectiveHosts\}/g : /selectedHosts=\{effectiveHosts\}/g) || []).length === (page === 'HostDetails' ? 3 : 2)
        && !/(?:\bhosts|selectedHosts)=\{selectedHosts\}(?! *\n? *onChange)/.test(src.replace(/<HostPicker[\s\S]*?\/>/, '')), page);
    check(`F6g3 ${page} takes its hosts from useOwnPicks`, src.indexOf('= useOwnPicks(selectedHosts, () => ') !== -1, page);
    check(`F6g5 ${page}'s panels clear on a pick made while a SID is on`,
        /<FilterKeyContext\.Provider value=\{ownFilterKey\}>[\s\S]*<TabbedLayout[\s\S]*<\/FilterKeyContext\.Provider>/.test(src), page);
    check(`F6g4 ${page} shows each host's role`, src.indexOf('useSidHostDescriptions()') !== -1, page);
    check(`F6h ${page} still applies only the Cloud filter to its queries`, src.indexOf('mapCloudProviderQueries') !== -1 && src.indexOf('mapQueryFilters') === -1, page);
});
const SEARCH = read(path.join(HOME, 'hooks', 'useSearch.ts'));
check('F6i useSearch dispatches nothing for an unavailable query, and clears old rows',
    /if \(isFilterUnavailable\(query\)\) \{\s*setResults\(\[\]\);\s*setRowsFor\(rowsKey\);\s*setLoading\(false\);[\s\S]*?return undefined;\s*\}\s*setLoading\(true\);/.test(SEARCH), 'useSearch.ts');
check('F6j it does not count as dispatched', SEARCH.indexOf('!!enabled && !!query && !isFilterUnavailable(query)') !== -1, 'useSearch.ts');
const HYBRID = read(path.join(HOME, 'hooks', 'useHybridSearch.ts'));
check('F6k an unavailable rollup read goes raw, before the twin is recorded',
    /if \(isFilterUnavailable\(cached\)\) return raw;[\s\S]*recordRawTwin\(cached, raw\);/.test(HYBRID), 'useHybridSearch.ts');
check('F6s nothing records a raw twin for the unavailable query',
    /recordRawTwin = [^\n]*\{\s*(?:\/\/[^\n]*\s*)*if \(isFilterUnavailable\(/.test(read(path.join(HOME, 'utils', 'rawTwin.ts'))), 'rawTwin.ts');
const LAYOUT = read(path.join(HOME, 'components', 'DashboardLayout.tsx'));
check('F6l a page out of the Cloud filter is out of these too',
    (LAYOUT.match(/\{!noCloudFilter && [^\n]*(SidPicker|GlobalHostPicker|ServiceHostPicker)/g) || []).length === 3, 'DashboardLayout.tsx');
check('F6m the provider is mounted', read(path.join(HOME, 'App.tsx')).indexOf('<SidHostFilterProvider>') !== -1, 'App.tsx');
check('F6n a persisted expansion is read synchronously',
    PROVIDER.indexOf('useState<SidHostSelection>(() => readSelection())') !== -1, 'SidHostFilterProvider.tsx');
check('F6o the terms and the Cloud filter both apply, the Cloud filter first',
    PROVIDER.indexOf('withSidHostTerms(withCloudProvider(query, f.cloud), f.terms)') !== -1, 'SidHostFilterProvider.tsx');
['components/EmptyStateHint.tsx', 'components/PanelMeta.tsx', 'components/KpiCard.tsx', 'components/Sparkline.tsx', 'utils/diagSweep.ts'].forEach((f) => {
    check(`F6p ${f} offers nothing for a search that never ran`, read(path.join(HOME, f)).indexOf('isFilterUnavailable(') !== -1, f);
});

/* ---- F8 rows from before a filter change are not drawn ---- */

const rf = (query: string, filterKey: string) => ({ query, filterKey });
check('F8a a filter change that changes the query hides the old rows', rowsAreStale(rf('q1', 'k1'), 'q2', 'k2') === true, 'stale');
check('F8b a filter change that leaves the query keeps them', rowsAreStale(rf('q1', 'k1'), 'q1', 'k2') === false, 'same query');
check('F8c a query change with no filter change behaves as it always has', rowsAreStale(rf('q1', 'k1'), 'q2', 'k1') === false, 'Cloud, time, span');
check('F8d nothing changed', rowsAreStale(rf('q1', 'k1'), 'q1', 'k1') === false, 'same');
check('F8e no rows yet', rowsAreStale(null, 'q1', 'k1') === false, 'first load');
check('F8f useSearch returns the guarded rows, and counts them',
    /const stale = rowsAreStale\(rowsFor, query, filterKey\);\s*const shownResults = stale \? null : results;\s*const rowCount = shownResults \? shownResults\.length : null;/.test(SEARCH)
    && /return \{\s*results: shownResults,/.test(SEARCH), 'useSearch.ts');
check('F8g new rows are stored before their key, so old rows never read as current',
    /setResults\(\(data && data\.results\) \|\| \[\]\);\s*setRowsFor\(rowsKey\);/.test(SEARCH), 'useSearch.ts');
check('F8h the key is the one the query was dispatched under', SEARCH.indexOf('const rowsKey: RowsFor = { query, filterKey: filterKeyRef.current };') !== -1, 'useSearch.ts');
check('F8i the provider supplies the key from what the filter applies',
    /const filterKey = JSON\.stringify\(\[\s*termsOf\(selection\),/.test(PROVIDER) && PROVIDER.indexOf('<FilterKeyContext.Provider value={filterKey}>') !== -1, 'SidHostFilterProvider.tsx');

check('F8j the first render after a filter change counts as loading, so no panel paints "No data"',
    SEARCH.indexOf('const shownLoading = loading || (stale && dispatched && !error);') !== -1 && /loading: shownLoading,\s*errorMessage/.test(SEARCH)
    && /results: shownResults,\s*loading: shownLoading,/.test(SEARCH), 'useSearch.ts');
check('F8k clearing an empty list changes no key', PROVIDER.indexOf('.filter((s) => (serviceHosts[s] ?? []).length > 0)') !== -1, 'filterKey');

/* ---- F10 a page's own picks under a SID ---- */

check('F10a no SID: the picks alone', same(ownHostsInScope(['h1'], []), ['h1']) && ownHostsInScope([], []).length === 0, 'no SID');
check('F10b a SID and no picks: all of it', same(ownHostsInScope([], ['h1', 'h2']), ['h1', 'h2']), 'scope');
check('F10c picks inside it', same(ownHostsInScope(['h1'], ['h1', 'h2']), ['h1']), 'inside');
check('F10d a pick outside it is ignored beside one inside', same(ownHostsInScope(['h1', 'h9'], ['h1', 'h2']), ['h1']), 'mixed');
check('F10e picks all outside show nothing, never other hosts', same(ownHostsInScope(['h9'], ['h1', 'h2']), [HOST_OUTSIDE_SID]), 'outside');
check('F10f a link from outside the SID stands when the SID is cleared', picksCameFromOutside(['h9'], 'XCQ', ['h1']) === true, 'link');
check('F10g a pick made under the SID does not', picksCameFromOutside(['h1'], 'XCQ', ['h1']) === false, 'made under');
check('F10h a pick made with no SID does not', picksCameFromOutside(['h1'], null, []) === false, 'no SID before');
check('F10i no picks', picksCameFromOutside([], 'XCQ', ['h1']) === false, 'none');
check('F10j a part-outside selection does not', picksCameFromOutside(['h1', 'h9'], 'XCQ', ['h1']) === false, 'mixed');
check('F10k picks are dropped during render, so no search runs for one the new SID does not hold',
    /const picks = dropPicks \? NO_PICKS : selectedHosts;/.test(PROVIDER) && /ownHostsInScope\(picks, scopeHosts\)/.test(PROVIDER), 'useOwnPicks');
check('F10l with no SID the page key is the parent\'s, so its picker behaves as it always has',
    PROVIDER.indexOf('ownFilterKey: sid ? JSON.stringify(effectiveHosts) : parentKey') !== -1, 'useOwnPicks');
check('F10m the report counts the new class', read(path.join(HOME, 'utils', 'diagReport.ts')).indexOf("count('not-filterable')") !== -1, 'diagReport.ts');

/* ---- F9 stored selections and the list ---- */

check('F9a a stored SID with nothing to stand for is dropped, so the button never reads a filter that is not on',
    PROVIDER.indexOf('if (sid && scopeHosts.length === 0) return NO_SELECTION;') !== -1, 'readSelection');
const PICKER = read(path.join(HOME, 'components', 'SidHostPicker.tsx'));
check('F9b the Host filter also offers hosts with no SID evidence, only with no SID selected', PROVIDER.indexOf("ALL_HOSTS_QUERY = '| tstats count WHERE `sap_logserv_idx_macro` BY host") !== -1
    && PICKER.indexOf('onOpen={selection.sid ? undefined : requestAllHosts}') !== -1 && PICKER.indexOf('(selection.sid ? [] : allHostNames)') !== -1, 'all hosts');
check('F9e a selected SID limits the menu even if the list cannot be read',
    PICKER.indexOf('entry ? entry.hosts : selection.scopeHosts.map(') !== -1, 'scope fallback');
check('F9c a picked host with no SID evidence survives a reload', PROVIDER.indexOf('known.has(') === -1, 'no pruning');
check('F9d an empty list is read again when the menu opens', read(path.join(HOME, 'components', 'SidHostPicker.tsx')).indexOf('map.sids.length === 0) refreshMap()') !== -1, 'refreshMap');

/* ---- F7 Data Doctor ---- */

const facts = (spl: string, extra = {}) => ({
    spl, earliest: '-30d@d', latest: 'now', dispatched: false, loading: false, errorMessage: null, rowCount: 0, ...extra,
});
const un = explainEmptyPanel(facts(FILTER_UNAVAILABLE_SPL));
check('F7a an unavailable panel says so', !!un && un.id === 'filter-unavailable' && un.short === 'Not filterable', JSON.stringify(un));
check('F7b and says nothing else', allFreeVerdicts(facts(FILTER_UNAVAILABLE_SPL)).length === 1, 'allFreeVerdicts');
const hostProbe = probeSpl(withSidHostTerms(hostRead, BOTH));
check('F7c a rollup host term reads as the host filter', !!hostProbe.hostFilter && same(hostProbe.hostFilter.hosts, ['h1', 'h2']), JSON.stringify(hostProbe.hostFilter));
const rawProbe = probeSpl(withSidHostTerms(rawRead, BOTH));
check('F7d a raw host term reads as the host filter', !!rawProbe.hostFilter && same(rawProbe.hostFilter.hosts, ['h1', 'h2']), JSON.stringify(rawProbe.hostFilter));
const sidProbe = probeSpl(withSidHostTerms(sidRead, BOTH));
check('F7e a rollup SID term reads as the SID filter', same(sidProbe.sidFilter || [], ['XCP']), JSON.stringify(sidProbe.sidFilter));
check('F7f and not as a grain filter', sidProbe.grainFilters.length === 0, JSON.stringify(sidProbe.grainFilters));
const compoundProbe = probeSpl(`| inputlookup logserv_linux_rollup where metric="sapapp" ${RANGE} | search ${sapSidTerm(['A44'], true)} | stats count`);
check('F7g the compound pattern is not named as a SID', same(compoundProbe.sidFilter || [], ['A44']), JSON.stringify(compoundProbe.sidFilter));
const own = probeSpl(`| inputlookup logserv_linux_rollup where metric="sapapp" ${RANGE} | search sap_sid="A44" | stats count`);
check('F7h a panel\'s own sap_sid search stays a grain filter', !own.sidFilter && own.grainFilters.length === 1, JSON.stringify(own.grainFilters));
const empty = explainEmptyPanel(facts(withSidHostTerms(sidRead, BOTH), { dispatched: true }));
check('F7i an empty SID-filtered panel names the filter', !!empty && empty.id === 'active-filters' && empty.headline.indexOf('the SID filter is set to XCP') !== -1, JSON.stringify(empty));
const emptyHost = explainEmptyPanel(facts(withSidHostTerms(hostRead, BOTH), { dispatched: true }));
check('F7j an empty host-filtered panel names the filter', !!emptyHost && emptyHost.headline.indexOf('the host filter is limited to 2 hosts') !== -1, JSON.stringify(emptyHost));

/* ---- F11 a click through to Splunk Search carries the page's filters (build 396) ---- */

const ts = require('typescript');
const DASH_DIR = path.join(HOME, 'dashboards');
const OWN_PICKER_PAGES = ['HostDetails.tsx', 'DataPipelineOverview.tsx'];
let searchLinks = 0;
fs.readdirSync(DASH_DIR).filter((f: string) => f.endsWith('.tsx')).forEach((f: string) => {
    const src = read(path.join(DASH_DIR, f));
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // The two pages with their own host picker hold the hosts in the SPL already.
    const want = OWN_PICKER_PAGES.indexOf(f) !== -1
        ? { fn: 'withCloudProvider', arg: 'provider' }
        : { fn: 'withQueryFilters', arg: 'filters' };
    const visit = (n: any): void => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === 'buildSplunkSearchUrl') {
            searchLinks += 1;
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            const a = n.arguments[0];
            const wrapped = ts.isCallExpression(a) && a.expression.getText(sf) === want.fn
                && !!a.arguments[1] && a.arguments[1].getText(sf) === want.arg;
            check(`F11a ${f}:${line} sends its SPL through ${want.fn}`, wrapped, a.getText(sf));
            let p = n.parent;
            while (p && !(ts.isCallExpression(p) && p.expression.getText(sf) === 'useCallback')) p = p.parent;
            if (p) {
                const deps = p.arguments[1];
                check(`F11b ${f}:${line} its useCallback depends on ${want.arg}`,
                    !!deps && ts.isArrayLiteralExpression(deps)
                    && deps.elements.some((e: any) => e.getText(sf) === want.arg),
                    deps ? deps.getText(sf) : 'no dependency array');
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    // withQueryFilters returns "unavailable" for a query with no macro and no rollup read.
    (src.match(/const spl =\s*[^;]{0,40}/g) || []).forEach((m: string) => {
        // Host Details' W is the macro plus its host fragment.
        check(`F11c ${f} every search link starts from the index macro`, /const spl =\s*[`']\\?`sap_logserv_idx_macro|const spl = `\$\{W\} /.test(m), m);
    });
});
check('F11d the dashboards hold the known number of search links', searchLinks === 56, String(searchLinks));
check('F11e the Total Errors link starts from the index macro',
    /const TOTAL_ERRORS_DRILLDOWN_SPL =\s*'`sap_logserv_idx_macro`/.test(read(path.join(DASH_DIR, 'EnvironmentHealth.tsx'))), 'EnvironmentHealth');
check('F11f Host Details starts from the host fragment its panels read',
    (read(path.join(DASH_DIR, 'HostDetails.tsx')).match(/const spl = `\$\{W\} (sourcetype|source)=/g) || []).length === 2, 'HostDetails');
check('F11g Data Pipeline Overview starts from the host fragment its panels read',
    /const spl = `\\`sap_logserv_idx_macro\\` \$\{HOST\} sourcetype=/.test(read(path.join(DASH_DIR, 'DataPipelineOverview.tsx'))), 'DataPipelineOverview');
const drill = '`sap_logserv_idx_macro` sourcetype="x" uri="a b" | sort -_time';
check('F11h the host terms land right after the macro, before the pipeline',
    withSidHostTerms(drill, { hosts: ['h1', 'h2'], sids: [] }) === '`sap_logserv_idx_macro` (host="h1" OR host="h2") sourcetype="x" uri="a b" | sort -_time',
    withSidHostTerms(drill, { hosts: ['h1', 'h2'], sids: [] }));

/* ===================================================================== */

if (qfFailures > 0) {
    process.stderr.write(`\nqueryFilters.consistency-test: ${qfFailures} failure(s) of ${qfChecks}\n`);
    process.exit(1);
}
console.log(`queryFilters.consistency-test: OK (${qfChecks} checks)`);
