/**
 * Build-time consistency test for the AI Assistant's KV Store ACLs (build 380).
 *
 * The settings row (logserv_ai_assistant_settings, _key "defaults") decides
 * where an admin's browser sends secrets and data: the audit forwarder URL
 * (with the HEC token), the MCP server URL (with its bearer token) and the
 * privacy tier. Until build 380 every role could write it, so any user could
 * redirect them. The T&C acknowledgements and the discovered-model cache had
 * the same open write.
 *
 * What it pins:
 *  - each of the three collections has exactly one default.meta stanza,
 *    readable by every role and writable by the admin tier only
 *    (admin, sc_admin, sc_subadmin - the app's own default);
 *  - no logserv_ai_* collection, now or later, is writable by every role;
 *  - the client paths a non-admin reaches (the conf-to-KV migrations at page
 *    load, the model-cache upsert) stay best-effort, so the write a non-admin
 *    now gets refused never breaks the page.
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

const META = path.resolve(__dirname, '../../../../resources/splunk/metadata/default.meta');
const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let aclFailures = 0;
let aclChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    aclChecks += 1;
    if (!ok) {
        aclFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

/** [stanza, access line] for every stanza of default.meta (comments skipped). */
const stanzas: [string, string | undefined][] = [];
{
    let cur: string | null = null;
    let access: string | undefined;
    read(META).split('\n').forEach((raw) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) return;
        const h = /^\[(.*)\]$/.exec(line);
        if (h) {
            if (cur !== null) stanzas.push([cur, access]);
            cur = h[1];
            access = undefined;
            return;
        }
        const m = /^access\s*=\s*(.*)$/.exec(line);
        if (m) access = m[1].trim();
    });
    if (cur !== null) stanzas.push([cur, access]);
}

const ADMIN_TIER = 'read : [ * ], write : [ admin, sc_admin, sc_subadmin ]';
const AI_COLLECTIONS = ['logserv_ai_assistant_settings', 'logserv_ai_assistant_acks', 'logserv_ai_models'];

AI_COLLECTIONS.forEach((c) => {
    const found = stanzas.filter(([s]) => s === `collections/${c}`);
    check(`A1 [collections/${c}] has exactly one default.meta stanza`, found.length === 1, `${found.length} stanza(s)`);
    check(`A2 [collections/${c}] is readable by every role and writable by the admin tier only`,
        found.length === 1 && found[0][1] === ADMIN_TIER, String(found.length ? found[0][1] : 'missing'));
});

const openAi = stanzas.filter(([s, a]) => /^collections\/logserv_ai_/.test(s) && /write\s*:\s*\[\s*\*\s*\]/.test(a || ''));
check('A3 no logserv_ai_* collection is writable by every role', openAi.length === 0,
    openAi.map(([s]) => s).join(', '));

/* ---- the non-admin paths stay best-effort ---- */
const code = (rel: string): string => read(path.join(HOME, rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const tel = code('utils/telemetryConfApi.ts');
check('B1 the acks migration still swallows a refused write',
    /export const migrateConfFileAcksToKvStore = async \(\): Promise<void> => \{\s*try \{/.test(tel)
    && /await writeKvAckRow\(record\);\s*\}\),\s*\);\s*\} catch \{/.test(tel),
    'migrateConfFileAcksToKvStore must keep its try { ... } catch { } around the KV write');
const disc = code('components/ai/modelDiscovery.ts');
// Build 381 (audit M1 of build 380): the catch must be the one of THIS try - no
// other try opens between the upsert and its catch, and the catch is empty.
check('B2 the model-cache upsert still swallows a refused write',
    /try \{\s*if \(ok\) \{\s*await writeModelCacheRow\((?:(?!try \{)[\s\S])*?\}\s*catch \{\s*\}/.test(disc),
    'refreshProviderModels must keep its own try { ... } catch { } around writeModelCacheRow');
/** The body of `export const <name> = async (...) => { ... };` (to its first top-level close). */
const fnBody = (src: string, name: string): string => {
    const i = src.indexOf(`export const ${name} = async`);
    if (i === -1) return '';
    const j = src.indexOf('\n};\n', i);
    return j === -1 ? '' : src.slice(i, j + 4);
};
const cfgApi = code('utils/aiConfigApi.ts');
const mig = fnBody(cfgApi, 'migrateConfFileSettingsToKvStore');
check('B3 the settings migration still swallows a refused write',
    /^export const migrateConfFileSettingsToKvStore = async \(\): Promise<void> => \{\s*try \{/.test(mig)
    && /await writeKvStoreRow\(fromConf\);[\s\S]*\}\s*catch \{\s*\}\s*\n\};\n$/.test(mig),
    'migrateConfFileSettingsToKvStore must wrap its whole body, the KV write included, in try { ... } catch { }');

/* ---- the Settings page's admin gate and the ACL name the same roles ---- */
const isAdminSrc = read(path.join(HOME, 'hooks', 'useIsAdmin.ts'));
const rolesM = /const ADMIN_TIER_ROLES = \[([^\]]*)\];/.exec(isAdminSrc);
const uiRoles = rolesM ? rolesM[1].split(',').map((s: string) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
check('C1 the Settings page admits exactly the roles the three collections let write (useIsAdmin ADMIN_TIER_ROLES)',
    JSON.stringify(uiRoles.slice().sort()) === JSON.stringify(['admin', 'sc_admin', 'sc_subadmin']),
    JSON.stringify(uiRoles));

if (aclFailures > 0) {
    process.stderr.write(`\naiKvAcl.consistency-test: ${aclFailures} failure(s) of ${aclChecks}\n`);
    process.exit(1);
}
console.log(`aiKvAcl.consistency-test: OK (${aclChecks} checks)`);
