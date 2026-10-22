/**
 * Build-time consistency test for the Settings > Audit Log viewer's search
 * (utils/auditQuery.ts buildSpl, build 394).
 *
 * The "User contains" filter puts user="*...*" in the base search, so Splunk
 * extracts user from the event's JSON to apply it, and spath then adds the
 * same value again: the field came back with two values and the User column
 * showed the name twice ("adminadmin"). buildSpl now re-derives user from
 * _raw after spath, as it already did for category.
 *
 * What it pins:
 *  - U1 / U2: with a user filter, the base search filters on user, and after
 *    spath `eval user=json_extract(_raw, "user")` replaces the field;
 *  - U3: the same re-derivation runs without the filter;
 *  - U4: category is still re-derived after spath, and the category filter
 *    still composes with the user filter;
 *  - U5: a double quote or backslash typed into the filter is escaped;
 *  - U6: the viewer's User cell renders row.user.
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
const aq = require('./auditQuery');

const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let aqFailures = 0;
let aqChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    aqChecks += 1;
    if (!ok) {
        aqFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

const filters = (over: Record<string, unknown>): any => ({
    earliest: '-30d', latest: 'now', categories: [], userContains: '', limit: 100, ...over,
});
const stages = (spl: string): string[] => spl.split(' | ');

const USER_EVAL = 'eval user=json_extract(_raw, "user")';
const CATEGORY_EVAL = 'eval category=json_extract(_raw, "category")';

/* ============================ buildSpl ============================ */

const withUser = stages(aq.buildSpl(filters({ userContains: 'admin' })));
check('U1 the base search filters on user', withUser[0].indexOf('user="*admin*"') !== -1, withUser[0]);
const spathAt = withUser.indexOf('spath');
const userEvalAt = withUser.indexOf(USER_EVAL);
check('U2 user is re-derived from _raw after spath (filter set)',
    spathAt !== -1 && userEvalAt > spathAt, `stages: ${JSON.stringify(withUser)}`);

const noFilter = stages(aq.buildSpl(filters({})));
check('U3 user is re-derived from _raw after spath (no filter)',
    noFilter.indexOf('spath') !== -1 && noFilter.indexOf(USER_EVAL) > noFilter.indexOf('spath'),
    `stages: ${JSON.stringify(noFilter)}`);
check('U3b no filter puts no user clause in the base search', noFilter[0].indexOf('user=') === -1, noFilter[0]);

const both = stages(aq.buildSpl(filters({ userContains: 'admin', categories: ['local_only', 'vendor_tier1'] })));
check('U4 category is re-derived from _raw after spath',
    both.indexOf(CATEGORY_EVAL) > both.indexOf('spath') && both.indexOf('spath') !== -1,
    `stages: ${JSON.stringify(both)}`);
check('U4b the category and user filters compose in the base search',
    both[0].indexOf('category IN ("local_only","vendor_tier1")') !== -1 && both[0].indexOf('user="*admin*"') !== -1,
    both[0]);

const quoted = stages(aq.buildSpl(filters({ userContains: 'a"b\\c' })));
check('U5 a double quote and a backslash in the filter are escaped',
    quoted[0].indexOf('user="*a\\"b\\\\c*"') !== -1, quoted[0]);

/* ============================ the viewer ============================ */

const VIEWER = read(path.join(HOME, 'components', 'AuditLogViewer.tsx'));
check('U6 the User cell renders row.user', VIEWER.indexOf("<td>{(row.user as string) || '—'}</td>") !== -1,
    'AuditLogViewer.tsx User cell');

/* ===================================================================== */

if (aqFailures > 0) {
    process.stderr.write(`\nauditQuery.consistency-test: ${aqFailures} failure(s) of ${aqChecks}\n`);
    process.exit(1);
}
console.log(`auditQuery.consistency-test: OK (${aqChecks} checks)`);
