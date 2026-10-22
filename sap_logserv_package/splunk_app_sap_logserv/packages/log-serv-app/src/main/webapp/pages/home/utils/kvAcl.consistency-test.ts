/**
 * Build-time consistency test for the App's KV Store write ACLs (build 384, session 161).
 *
 * Until build 384 every logserv_* collection except the AI Assistant's three and the backfill stage was writable
 * by every role, so any signed-in user could alter or delete what the dashboards show through Splunk's REST API.
 * Build 384 closes the dashboard rollups, the topology collections and the Data Doctor's platform snapshot to the
 * admin tier and keeps open only the six collections ordinary users write by design
 * (testing/s161_followups/kv_acl_plan/PLAN.md).
 *
 * What it pins:
 *  K1 every collection in collections.conf has exactly one [collections/<name>] stanza in default.meta, and
 *     default.meta names no other collection;
 *  K2 only the declared OPEN set is writable by every role; every other collection is readable by every role and
 *     writable by the admin tier only (admin, sc_admin, sc_subadmin); all export = system;
 *  K3 the [] stanza stays admin-tier write (owner nobody, export system), and default.meta has no bare
 *     [collections] or any [transforms...] / [savedsearches...] stanza that could reopen what K2 closes;
 *  K4 every outputlookup target in savedsearches.conf resolves (through transforms.conf) to a known collection or
 *     one of the ES feeds' CSV files, and every saved search that writes - and only those - sets dispatchAs = user;
 *  K5 the browser's KV writers are exactly the declared files: each OPEN collection keeps its non-admin writer, the
 *     closed collections are written only by the Settings page's backfill panel (mounted only behind its admin
 *     gate) and the AI Assistant modules, and the panel's targets are all closed;
 *  K6 the Settings page's admin roles (useIsAdmin ADMIN_TIER_ROLES) are exactly the closed collections' write roles;
 *  K7 the refresh-interval clamp: ALLOWED_INTERVALS_MS equals the picker's options and collections.conf's
 *     documented set, and loadDashboardInterval returns only those values.
 *
 * Path overrides for mutation checks: KVACL_META, KVACL_SAVED (otherwise the shipped files).
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
    env: { [k: string]: string | undefined };
    stderr: { write(s: string): void };
    exit(code: number): never;
};

const fs = require('fs');
const path = require('path');

const RES = path.resolve(__dirname, '../../../../resources/splunk');
const META = process.env.KVACL_META || path.join(RES, 'metadata', 'default.meta');
const SAVED = process.env.KVACL_SAVED || path.join(RES, 'default', 'savedsearches.conf');
const COLLECTIONS = path.join(RES, 'default', 'collections.conf');
const TRANSFORMS = path.join(RES, 'default', 'transforms.conf');
const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let kvFailures = 0;
let kvChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    kvChecks += 1;
    if (!ok) {
        kvFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

const ADMIN_ROLES = ['admin', 'sc_admin', 'sc_subadmin'];
const ADMIN_TIER = 'read : [ * ], write : [ admin, sc_admin, sc_subadmin ]';
const OPEN_ACL = 'read : [ * ], write : [ * ]';
/** Written by ordinary users by design (PLAN.md; the user's decision of 2026-10-17 keeps the two diag ones open). */
const OPEN = [
    'logserv_topology_layouts', 'logserv_topology_layout_defaults', 'logserv_topology_active_mode',
    'logserv_dashboard_refresh', 'logserv_diag_reports', 'logserv_diag_ingest_facts',
];
const AI = ['logserv_ai_assistant_settings', 'logserv_ai_assistant_acks', 'logserv_ai_models'];
const ES_CSVS = ['splunk_for_sap_logserv_assets.csv', 'splunk_for_sap_logserv_identities.csv'];

/** Conf stanzas as {name: {key: value}} (comments and blank lines skipped; continuation lines kept raw). */
const parseConf = (text: string): { [s: string]: { [k: string]: string } } => {
    const out: { [s: string]: { [k: string]: string } } = {};
    let cur: string | null = null;
    text.split('\n').forEach((raw) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const h = /^\[(.*)\]$/.exec(line);
        if (h) {
            cur = h[1];
            if (out[cur] === undefined) out[cur] = {};
            out[cur]['__count'] = String(Number(out[cur]['__count'] || 0) + 1);
            return;
        }
        const kv = /^([A-Za-z0-9_.:]+)\s*=\s*(.*)$/.exec(line);
        if (kv && cur !== null) out[cur][kv[1]] = kv[2];
    });
    return out;
};

const meta = parseConf(read(META));
const collNames = Object.keys(parseConf(read(COLLECTIONS)));

/* ---- K1 one stanza per collection, none for an unknown one ---- */
check('K1a collections.conf defines 40 collections', collNames.length === 40, String(collNames.length));
collNames.forEach((c) => {
    const s = meta[`collections/${c}`];
    check(`K1 [collections/${c}] has exactly one default.meta stanza`, !!s && s['__count'] === '1',
        s ? `${s['__count']} stanza(s)` : 'missing');
});
const metaColls = Object.keys(meta).filter((s) => s.startsWith('collections/')).map((s) => s.slice('collections/'.length));
check('K1b default.meta names no collection collections.conf does not define',
    metaColls.every((c) => collNames.indexOf(c) !== -1), metaColls.filter((c) => collNames.indexOf(c) === -1).join(', '));

/* ---- K2 the OPEN set and nothing else is writable by every role ---- */
check('K2a the OPEN set and the AI collections are real collections',
    OPEN.concat(AI).every((c) => collNames.indexOf(c) !== -1), OPEN.concat(AI).filter((c) => collNames.indexOf(c) === -1).join(', '));
collNames.forEach((c) => {
    const s = meta[`collections/${c}`] || {};
    const want = OPEN.indexOf(c) !== -1 ? OPEN_ACL : ADMIN_TIER;
    check(`K2 [collections/${c}] access is ${OPEN.indexOf(c) !== -1 ? 'open' : 'admin-tier write'}`,
        s.access === want, String(s.access));
    check(`K2 [collections/${c}] export = system`, s.export === 'system', String(s.export));
});
const closed = collNames.filter((c) => OPEN.indexOf(c) === -1);
check('K2b 34 collections are closed (30 since build 384, the stage, the three AI ones)', closed.length === 34,
    String(closed.length));

/* ---- K3 the defaults cannot reopen them ---- */
const g = meta[''] || {};
check('K3a [] is owner nobody, admin-tier write, export system',
    g.owner === 'nobody' && g.access === ADMIN_TIER && g.export === 'system', JSON.stringify(g));
const wider = Object.keys(meta).filter((s) => s === 'collections' || /^(transforms|savedsearches)(\/|$)/.test(s));
check('K3b no bare [collections], [transforms...] or [savedsearches...] stanza', wider.length === 0, wider.join(', '));

/* ---- K4 outputlookup targets resolve, and every writer sets dispatchAs = user ---- */
const lookups = parseConf(read(TRANSFORMS));
const saved: { name: string; body: string }[] = [];
{
    let cur: { name: string; body: string } | null = null;
    read(SAVED).split('\n').forEach((raw) => {
        const h = /^\[([^\]]+)\]\s*$/.exec(raw);
        if (h) {
            cur = { name: h[1], body: '' };
            saved.push(cur);
            return;
        }
        if (cur !== null && !raw.trim().startsWith('#')) cur.body += raw + '\n';
    });
}
const writers = saved.filter((s) => /\boutputlookup\b/.test(s.body));
check('K4a 91 saved searches write with outputlookup (30 aggregates, 30 retentions, 29 backfills, 2 ES feeds)',
    writers.length === 91, String(writers.length));
writers.forEach((s) => {
    // Splunk keeps the LAST value of a repeated key, so the last dispatchAs line is the one that counts.
    // Build 385: every value counts, empty or several words included (`dispatchAs =`, `dispatchAs = owner # x`).
    const da = (s.body.match(/^dispatchAs\s*=.*$/gm) || []).map((l) => l.replace(/^dispatchAs\s*=/, '').trim());
    check(`K4b [${s.name}] writes, so it sets dispatchAs = user (and no later line overrides it)`,
        da.length > 0 && da[da.length - 1] === 'user', JSON.stringify(da));
    const re = /\boutputlookup\s+(?:[a-z_]+=\S+\s+)*([A-Za-z0-9_.:-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s.body)) !== null) {
        const target = m[1];
        const lk = lookups[target];
        const ok = ES_CSVS.indexOf(target) !== -1
            || (!!lk && !!lk.collection && collNames.indexOf(lk.collection) !== -1);
        check(`K4c [${s.name}] outputlookup ${target} resolves to a known collection or ES feed CSV`, ok,
            lk ? `collection = ${lk.collection}` : 'no lookup definition');
    }
});
const extra = saved.filter((s) => /^dispatchAs\s*=/m.test(s.body) && !/\boutputlookup\b/.test(s.body));
check('K4d no saved search that does not write sets dispatchAs', extra.length === 0, extra.map((s) => s.name).join(', '));

/* ---- K5 the browser's KV writers ---- */
const code = (rel: string): string => read(path.join(HOME, rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const listFiles = (dir: string): string[] => {
    const out: string[] = [];
    fs.readdirSync(dir).forEach((n: string) => {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) out.push(...listFiles(p));
        else if (/\.(ts|tsx)$/.test(n) && !/consistency-test|\.test\./.test(n)) out.push(p);
    });
    return out;
};
const rel = (p: string): string => path.relative(HOME, p).split(path.sep).join('/');
const OPEN_WRITERS: { [file: string]: string[] } = {
    'topology/persistence.ts': ['logserv_topology_layouts', 'logserv_topology_layout_defaults', 'logserv_topology_active_mode'],
    'state/dashboardRefreshPersistence.ts': ['logserv_dashboard_refresh'],
    'utils/diagPersistence.ts': ['logserv_diag_reports'],
    'utils/diagIngestFacts.ts': ['logserv_diag_ingest_facts'],
};
const ADMIN_WRITERS = ['components/RollupBackfillPanel.tsx', 'utils/aiConfigApi.ts', 'utils/telemetryConfApi.ts',
    'components/ai/modelDiscovery.ts'];
const READERS = ['hooks/useTopologyData.ts', 'topology/enrichment.ts', 'utils/diagProbe.ts'];
const kvFiles = listFiles(HOME).filter((p) => read(p).indexOf('storage/collections/data') !== -1).map(rel).sort();
const declared = Object.keys(OPEN_WRITERS).concat(ADMIN_WRITERS, READERS).sort();
check('K5a the files that use the KV data endpoint are exactly the declared writers and readers',
    JSON.stringify(kvFiles) === JSON.stringify(declared), `found ${JSON.stringify(kvFiles)}`);
READERS.forEach((f) => {
    const src = code(f);
    // Build 385: any letter case (fetch upper-cases the method), PUT / PATCH too, and no method held in a variable.
    const posts = (src.match(/method:\s*['"`]POST['"`]/gi) || []).length;
    const oneshot = (src.match(/url:\s*ONESHOT_URL,\s*init:\s*\{\s*method:\s*['"`]POST['"`]/gi) || []).length;
    const varMethod = /\bmethod\s*:(?!\s*['"`])|[{,]\s*method\s*[,}]/.test(src);
    check(`K5b ${f} only reads KV (no DELETE / PUT / PATCH; any POST is a oneshot search; every method is a literal)`,
        !/method:\s*['"`](DELETE|PUT|PATCH)['"`]/i.test(src) && posts === oneshot && !varMethod,
        `${posts} POST, ${oneshot} oneshot, a variable method: ${varMethod}`);
});
const collsIn = (src: string): string[] => collNames.filter((c) => new RegExp(`'${c}'`).test(src));
Object.keys(OPEN_WRITERS).forEach((f) => {
    const src = code(f);
    const named = collsIn(src);
    check(`K5c ${f} writes its open collection(s) ${OPEN_WRITERS[f].join(', ')}`,
        OPEN_WRITERS[f].every((c) => named.indexOf(c) !== -1) && /method:\s*'(POST|DELETE)'/.test(src),
        `names ${JSON.stringify(named)}`);
    check(`K5d ${f} names no closed collection`, named.every((c) => OPEN.indexOf(c) !== -1),
        JSON.stringify(named.filter((c) => OPEN.indexOf(c) === -1)));
});
OPEN.forEach((c) => {
    check(`K5e the open collection ${c} keeps a declared non-admin writer`,
        Object.keys(OPEN_WRITERS).some((f) => OPEN_WRITERS[f].indexOf(c) !== -1), 'no writer declared');
});
// Build 385: each AI module names exactly its own collection, in any quoting (collsIn sees single quotes only).
const OWN_AI: Record<string, string> = {
    'utils/aiConfigApi.ts': 'logserv_ai_assistant_settings',
    'utils/telemetryConfApi.ts': 'logserv_ai_assistant_acks',
    'components/ai/modelDiscovery.ts': 'logserv_ai_models',
};
const collsAny = (src: string): string[] =>
    collNames.filter((c) => new RegExp(`(^|[^A-Za-z0-9_])${c}(?![A-Za-z0-9_])`).test(src));
Object.keys(OWN_AI).forEach((f) => {
    const named = collsAny(code(f));
    check(`K5j ${f} names exactly its own AI Assistant collection (${OWN_AI[f]}), in any quoting`,
        JSON.stringify(named) === JSON.stringify([OWN_AI[f]]) && AI.indexOf(OWN_AI[f]) !== -1,
        JSON.stringify(named));
});
const importers = listFiles(HOME).filter((p) => /from '[^']*\/RollupBackfillPanel'/.test(read(p))).map(rel);
check('K5f the backfill panel is imported only by the Settings page',
    JSON.stringify(importers) === JSON.stringify(['dashboards/AIAssistantSettings.tsx']), JSON.stringify(importers));
const settings = code('dashboards/AIAssistantSettings.tsx');
const gateAt = settings.search(/const \{ isAdmin[^}]*\} = useIsAdmin\(\);[\s\S]*?if \(!isAdmin\) \{/);
const gateEnd = gateAt === -1 ? -1 : settings.indexOf('if (!isAdmin) {', gateAt);
const panelAt = settings.indexOf('<RollupBackfillPanel');
check('K5g the Settings page mounts the panel only after its admin gate returns for non-admins',
    gateEnd !== -1 && panelAt > gateEnd && settings.indexOf('<RollupBackfillPanel', panelAt + 1) === -1,
    `gate ${gateEnd}, panel ${panelAt}`);
const registry = code('routes/rollupRegistry.ts');
// single(key, label, coll?) names `logserv_${key}_rollup` unless coll is given; multi-collection entries list
// their names as literals.
const regSet: { [c: string]: true } = {};
{
    const re = /\bsingle\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*(?:,\s*'([a-z_]+)')?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(registry)) !== null) regSet[m[2] || `logserv_${m[1]}_rollup`] = true;
    collNames.filter((c) => new RegExp(`'${c}'`).test(registry)).forEach((c) => { regSet[c] = true; });
}
const regColls = Object.keys(regSet).sort();
check('K5h the panel\'s targets (rollupRegistry collections: 24 rollups + 5 topology) are all closed',
    regColls.length === 29 && regColls.every((c) => collNames.indexOf(c) !== -1 && OPEN.indexOf(c) === -1),
    JSON.stringify(regColls));
const stageM = /export const STAGE_COLLECTION = '([a-z_]+)';/.exec(code('utils/backfillPlan.ts'));
check('K5i the panel\'s stage collection is closed', !!stageM && closed.indexOf(stageM[1]) !== -1,
    String(stageM && stageM[1]));

/* ---- K6 the Settings page admits exactly the closed collections' write roles ---- */
const rolesM = /const ADMIN_TIER_ROLES = \[([^\]]*)\];/.exec(read(path.join(HOME, 'hooks', 'useIsAdmin.ts')));
const uiRoles = rolesM ? rolesM[1].split(',').map((s: string) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
check('K6 useIsAdmin ADMIN_TIER_ROLES == the closed collections\' write roles',
    JSON.stringify(uiRoles.slice().sort()) === JSON.stringify(ADMIN_ROLES.slice().sort()), JSON.stringify(uiRoles));

/* ---- K7 the refresh-interval clamp ---- */
const nums = (expr: string): number => expr.replace(/_/g, '').split('*').map((x) => Number(x.trim()))
    .reduce((a, b) => a * b, 1);
const persist = code('state/dashboardRefreshPersistence.ts');
const allowedM = /export const ALLOWED_INTERVALS_MS: readonly number\[\] = \[([^\]]*)\];/.exec(persist);
const allowed = allowedM ? allowedM[1].split(',').map((s: string) => nums(s)) : [];
const picker = code('components/RefreshIntervalPicker.tsx');
const pickerVals: number[] = [];
{
    const re = /valueMs:\s*([0-9_*\s]+?)\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(picker)) !== null) pickerVals.push(nums(m[1]));
}
const docM = /The supported values are\s*\n#\s*\{([^}]*)\}/.exec(read(COLLECTIONS));
const docVals = docM ? docM[1].split(',').map((s: string) => Number(s.trim())) : [];
check('K7a ALLOWED_INTERVALS_MS equals the picker\'s options',
    allowed.length > 0 && JSON.stringify(allowed) === JSON.stringify(pickerVals), `${JSON.stringify(allowed)} vs ${JSON.stringify(pickerVals)}`);
check('K7b ALLOWED_INTERVALS_MS equals collections.conf\'s documented set',
    JSON.stringify(allowed) === JSON.stringify(docVals), `${JSON.stringify(allowed)} vs ${JSON.stringify(docVals)}`);
check('K7c loadDashboardInterval returns only allowed values',
    /return ALLOWED_INTERVALS_MS\.indexOf\(n\) !== -1 \? n : null;/.test(persist)
    && !/n >= 0 \? n : null/.test(persist), 'the read path does not clamp');

if (kvFailures > 0) {
    process.stderr.write(`\nkvAcl.consistency-test: ${kvFailures} failure(s) of ${kvChecks}\n`);
    process.exit(1);
}
console.log(`kvAcl.consistency-test: OK (${kvChecks} checks; ${closed.length} closed, ${OPEN.length} open, `
    + `${writers.length} writer searches with dispatchAs = user)`);
