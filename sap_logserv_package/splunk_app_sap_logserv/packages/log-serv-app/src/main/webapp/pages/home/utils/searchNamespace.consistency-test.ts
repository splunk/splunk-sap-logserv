/**
 * Build-time consistency test: every search the App dispatches itself runs in the LogServ App's namespace (build
 * 403). Not covered: the AI Assistant's free-form questions, which the Splunk MCP Server dispatches (its run_query
 * takes no app), and the patterns N3 does not look for (search/v2/jobs, jobs/export, SearchJob.fromSavedSearch).
 *
 * Up to build 402 the panel hook (hooks/useSearch.ts) created its jobs through /services/search/jobs, which runs a
 * job in the user's default app (Launcher, Search & Reporting). Such a job sees the App's macro
 * (`sap_logserv_idx_macro`), its lookup definitions (every rollup read) and its field extractions only while the App
 * is shared to all apps. A customer who shared the App "App" only got empty panels and 0 KPI cards; reproduced on the
 * reference system: the macro "cannot be found" and the rollup read returns 0 rows through /services, while the same
 * reads through /servicesNS/<user>/splunk_app_sap_logserv return every row, under either sharing.
 *
 * What it pins:
 *  - N1: useSearch creates its job with the namespace { app: 'splunk_app_sap_logserv', owner: <the signed-in user,
 *    'nobody' when unknown> }, and that is the only SearchJob.create in the App;
 *  - N2: @splunk/splunk-utils' own URL builder turns that namespace into
 *    /servicesNS/<user>/splunk_app_sap_logserv/search/jobs (so the job is not dispatched under /services);
 *  - N3: no other code starts a search under /services: the only /services/search/jobs URLs in the App are the
 *    results download of a job by its sid (drilldownUrls) and the Data Doctor's list of the user's own jobs
 *    (diagEvidence); every search/jobs POST and every oneshot is built under servicesNS/.../<this App>; nothing
 *    imports splunk-utils' oneShot or createSearchJob;
 *  - N4: metadata/default.meta keeps the App's search-time knowledge (macros, eventtypes, tags, props, transforms,
 *    fields, lookups) shared with all apps through export-only type stanzas, whatever the App's own sharing.
 */
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');

const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) {
        failures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).reduce((acc: string[], d: any) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return acc.concat(walk(p));
    return /\.(ts|tsx)$/.test(d.name) && !/consistency-test/.test(d.name) ? acc.concat([p]) : acc;
}, []);
const rel = (p: string): string => path.relative(HOME, p).split(path.sep).join('/');
const codeOf = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const FILES = walk(HOME);

// N1
const us = read(path.join(HOME, 'hooks/useSearch.ts'));
const usCode = codeOf(us);
check('N1 the app constant', /\nconst SEARCH_APP = 'splunk_app_sap_logserv';/.test(us), 'useSearch.ts must define SEARCH_APP');
check('N1 the user', /^import \{ username as splunkUsername \} from '@splunk\/splunk-utils\/config';$/m.test(us),
    'useSearch.ts must import username from @splunk/splunk-utils/config');
check('N1 the namespace on the create call',
    /\(SearchJob as any\)\.create\(\s*\{[\s\S]*?\},\s*\{ app: SEARCH_APP, owner: splunkUsername \|\| 'nobody' \},\s*\);/.test(usCode),
    'SearchJob.create(<params>, { app: SEARCH_APP, owner: splunkUsername || \'nobody\' })');
const creates = FILES.reduce((acc: string[], p: string) =>
    acc.concat((codeOf(read(p)).match(/SearchJob(?: as any\))?\.create\(/g) || []).map(() => rel(p))), []);
check('N1 one SearchJob.create, in useSearch', JSON.stringify(creates) === JSON.stringify(['hooks/useSearch.ts']),
    `SearchJob.create found in ${JSON.stringify(creates)}`);

// N2: the library's own URL builder.
let n2 = '';
try {
    const url = require('@splunk/splunk-utils/url');
    const got = url.createRESTURL('search/jobs', { app: 'splunk_app_sap_logserv', owner: 'jane.doe' },
        { splunkdPath: '/en-US/splunkd/__raw' });
    const nobody = url.createRESTURL('search/jobs', { app: 'splunk_app_sap_logserv', owner: 'nobody' },
        { splunkdPath: '/en-US/splunkd/__raw' });
    const none = url.createRESTURL('search/jobs', {}, { splunkdPath: '/en-US/splunkd/__raw' });
    if (got !== '/en-US/splunkd/__raw/servicesNS/jane.doe/splunk_app_sap_logserv/search/jobs'
        || nobody !== '/en-US/splunkd/__raw/servicesNS/nobody/splunk_app_sap_logserv/search/jobs'
        || none !== '/en-US/splunkd/__raw/services/search/jobs') {
        n2 = `createRESTURL gave ${got} / ${nobody} / ${none}`;
    }
} catch (err) {
    n2 = `@splunk/splunk-utils/url not loadable: ${String(err)}`;
}
check('N2 the namespace makes a servicesNS URL in this App', n2 === '', n2);

// N3
const services: string[] = [];
const posts: string[] = [];
FILES.forEach((p: string) => {
    const code = codeOf(read(p));
    (code.match(/[^\n]*\/services\/search\/jobs[^\n]*/g) || []).forEach((l: string) => services.push(`${rel(p)}: ${l.trim()}`));
    (code.match(/[^\n]*search\/jobs\/oneshot[^\n]*|[^\n]*\/search\/jobs\?output_mode=json[^\n]*/g) || [])
        .forEach((l: string) => posts.push(`${rel(p)}: ${l.trim()}`));
    if (/\b(oneShot|createSearchJob)\b[^\n]*from '@splunk\/splunk-utils\/search'|from '@splunk\/splunk-utils\/search'/.test(code)) {
        services.push(`${rel(p)}: imports @splunk/splunk-utils/search`);
    }
});
const SERVICES_OK = [
    /^utils\/drilldownUrls\.ts: `\/en-US\/splunkd\/__raw\/services\/search\/jobs\/\$\{encodeURIComponent\($/,
];
const servicesBad = services.filter((s: string) => !SERVICES_OK.some((re: RegExp) => re.test(s)));
check('N3 /services/search/jobs only for a job by its sid', servicesBad.length === 0 && services.length === 1,
    `found ${JSON.stringify(services)}`);
const evidence = codeOf(read(path.join(HOME, 'utils/diagEvidence.ts')));
check('N3 the Data Doctor only lists the user\'s jobs under /services (a GET, no search)',
    /export const RAW_SERVICES = '\/en-US\/splunkd\/__raw\/services';/.test(evidence)
    && (evidence.match(/\$\{RAW_SERVICES\}\/search\/jobs/g) || []).length === 1
    && /`\$\{RAW_SERVICES\}\/search\/jobs\?output_mode=json&count=\$\{OWN_JOBS_COUNT_CAP\}&f=dispatchState`/.test(evidence),
    'diagEvidence.ts: one ${RAW_SERVICES}/search/jobs?output_mode=json&count=...&f=dispatchState');
// Every POST / oneshot URL is built on a servicesNS prefix of this App (NS_PREFIX, BASE or the auditQuery constant).
// Two lines are not dispatches: the Audit Log viewer's help text, and the Data Doctor's job list (a GET, pinned above).
const postsBad = posts.filter((s: string) => !/\$\{(NS_PREFIX|BASE)\}\/search\/jobs|servicesNS\/nobody\/\$\{APP_NAMESPACE\}\/search\/jobs\/oneshot|ONESHOT_URL/.test(s)
    && !/^components\/AuditLogViewer\.tsx: <code>services\/search\/jobs\/oneshot<\/code>/.test(s)
    && !/^utils\/diagEvidence\.ts: `\$\{RAW_SERVICES\}\/search\/jobs\?output_mode=json&count=/.test(s));
check('N3 every search POST and oneshot is under servicesNS/.../this App', posts.length > 0 && postsBad.length === 0,
    `posts ${JSON.stringify(posts)}`);
const prefixes = [
    ['components/RollupBackfillPanel.tsx', /const NS_PREFIX = `\/en-US\/splunkd\/__raw\/servicesNS\/nobody\/\$\{APP\}`;/, /const APP = 'splunk_app_sap_logserv';/],
    ['utils/diagProbe.ts', /const BASE = `\/en-US\/splunkd\/__raw\/servicesNS\/nobody\/\$\{APP_NAMESPACE\}`;/, /const APP_NAMESPACE = 'splunk_app_sap_logserv';/],
    ['utils/auditQuery.ts', /servicesNS\/nobody\/\$\{APP_NAMESPACE\}\/search\/jobs\/oneshot/, /const APP_NAMESPACE = 'splunk_app_sap_logserv';/],
];
const prefixBad = prefixes.filter(([f, a, b]: any[]) => {
    const src = read(path.join(HOME, f));
    return !a.test(src) || !b.test(src);
}).map(([f]: any[]) => f);
check('N3 those prefixes name this App', prefixBad.length === 0, `not in this App's namespace: ${JSON.stringify(prefixBad)}`);

// N4 (build 403): the App's search-time knowledge stays shared with all apps under the App's "This app only" sharing:
// one type stanza each, exactly `export = system` (no access line, so access still follows the App's), for every
// knowledge type the App ships (Enterprise Security, the CIM data models, the MCP Server's free-form queries and other
// apps read them from outside the App). Measured on the reference system with build 402 under "This app only": the
// macro could not be found, field extractions and lookups returned 0 rows from the user's default app.
const RES = path.resolve(HOME, '../../../resources/splunk');
const metaSrc = read(path.join(RES, 'metadata/default.meta'));
// Parsed as Splunk reads it: comments and blank lines skipped, stanzas of the same name merged (and counted).
const metaConf: { [s: string]: { [k: string]: string } } = {};
{
    let cur: string | null = null;
    metaSrc.split('\n').forEach((raw: string) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const h = /^\[(.*)\]$/.exec(line);
        if (h) {
            cur = h[1];
            if (metaConf[cur] === undefined) metaConf[cur] = {};
            metaConf[cur].__count = String(Number(metaConf[cur].__count || 0) + 1);
            return;
        }
        const kv = /^([A-Za-z0-9_.:]+)\s*=\s*(.*)$/.exec(line);
        if (kv && cur !== null) metaConf[cur][kv[1]] = kv[2];
    });
}
const keysOf = (st: string): string => JSON.stringify(Object.keys(metaConf[st] || {}).filter((k: string) => k !== '__count'));
const TYPES: Array<[string, string]> = [
    ['macros', 'default/macros.conf'], ['eventtypes', 'default/eventtypes.conf'], ['tags', 'default/tags.conf'],
    ['props', 'default/props.conf'], ['transforms', 'default/transforms.conf'], ['fields', 'default/fields.conf'],
    ['lookups', 'lookups'], ['correlationsearches', 'default/correlationsearches.conf'],
];
const typeBad = TYPES.filter(([t, f]: [string, string]) => !fs.existsSync(path.join(RES, f)) || metaConf[t] === undefined
    || metaConf[t].__count !== '1' || keysOf(t) !== '["export"]' || metaConf[t].export !== 'system')
    .map(([t]: [string, string]) => `${t}: ${JSON.stringify(metaConf[t] || null)}`);
check('N4 every shipped knowledge type has one export-only [type] stanza (export = system, nothing else)',
    typeBad.length === 0, typeBad.join('; '));
// No object of these types opts back into the App's sharing (an object-level export line would win over [type]).
const objectExports = Object.keys(metaConf).filter((st: string) => TYPES.some(([t]: [string, string]) => st.startsWith(`${t}/`))
    && metaConf[st].export !== undefined);
check('N4 no object-level export line on the exported types', objectExports.length === 0, JSON.stringify(objectExports));
// Every knowledge conf the App ships is in the list (the rest are the App's own settings and objects that follow []).
const NOT_KNOWLEDGE = ['app.conf', 'server.conf', 'collections.conf', 'savedsearches.conf', 'ai_assistant_acks.conf',
    'ai_assistant_settings.conf', 'splunk_create.conf'];
const confs = fs.readdirSync(path.join(RES, 'default')).filter((f: string) => /\.conf$/.test(f));
const unlisted = confs.filter((f: string) => NOT_KNOWLEDGE.indexOf(f) === -1
    && !TYPES.some(([, file]: [string, string]) => file === `default/${f}`));
check('N4 every conf the App ships is either an exported knowledge type or one of its own settings / objects',
    unlisted.length === 0, `unlisted: ${JSON.stringify(unlisted)}`);
check('N4 the App itself stays exported by default, and its views, saved searches and nav have no type stanza',
    /^\[\]\nowner = nobody\naccess = read : \[ \* \], write : \[ admin, sc_admin, sc_subadmin \]\nexport = system$/m.test(metaSrc)
    && ['views', 'savedsearches', 'nav'].every((t: string) => metaConf[t] === undefined),
    'the [] stanza or a [views] / [savedsearches] / [nav] stanza changed');

if (failures > 0) {
    process.stderr.write(`searchNamespace.consistency-test: ${failures} of ${checks} checks FAILED\n`);
    process.exit(1);
}
// eslint-disable-next-line no-console
console.log(`searchNamespace.consistency-test: ${checks} checks passed`);
