/**
 * Build-time consistency test for the ABAP work process trace components
 * (Host Details "ABAP Work Process Trace Components", rollup metric abap_wp).
 *
 * The panel used to group by wp_type, which nothing extracts, so the rollup arm
 * never wrote a row and the panel never showed. It now stores the trace
 * component letter (EXTRACT-wp_category) and names it at read time.
 *
 * What it pins:
 *  - wpCategoryNameEval('wp_category', 'wp_category_name') is props.conf's
 *    [sap:abap:workprocess] EVAL-wp_category_name, byte for byte, as an eval;
 *  - EXTRACT-wp_category is still the one-letter component at the line start;
 *  - both hostrole searches (the hourly aggregate and the Settings backfill)
 *    store abap_wp by wp_category, and no shipped search, panel or conf reads
 *    wp_type again;
 *  - the Host Details panel reads abap_wp as wp_category and names it with
 *    wpCategoryNameEval on both arms (rollup and sub-hour raw).
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
const wp = require('./wpCategory');

const DEF = path.resolve(__dirname, '../../../../resources/splunk/default');
const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let wpFailures = 0;
let wpChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    wpChecks += 1;
    if (!ok) {
        wpFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

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
const keyOf = (lines: string[], key: string): string | undefined => {
    const hit = lines.find((l) => l.indexOf(`${key} =`) === 0 || l.indexOf(`${key}=`) === 0);
    return hit === undefined ? undefined : hit.slice(hit.indexOf('=') + 1).trim();
};

/* ============================ props.conf ============================ */

const WP = stanzaLines(read(path.join(DEF, 'props.conf')), 'sap:abap:workprocess');
const evalRhs = keyOf(WP, 'EVAL-wp_category_name') || '';
const built = wp.wpCategoryNameEval('wp_category', 'wp_category_name');
check('P1 wpCategoryNameEval is props.conf EVAL-wp_category_name, byte for byte',
    `eval wp_category_name=${evalRhs}` === built, `props: ${evalRhs}\n  util:  ${built}`);
check('P2 EXTRACT-wp_category is the one-letter trace component at the line start',
    keyOf(WP, 'EXTRACT-wp_category') === '^(?<wp_category>[A-Z])\\s{2}', String(keyOf(WP, 'EXTRACT-wp_category')));
check('P3 every name starts with its own letter',
    wp.WP_CATEGORY_NAMES.every(([k, v]: [string, string]) => /^[A-Z]$/.test(k) && v.indexOf(`${k} = `) === 0),
    JSON.stringify(wp.WP_CATEGORY_NAMES));

/* ============================ savedsearches.conf ============================ */

const SS = read(path.join(DEF, 'savedsearches.conf'));
const ARM = 'stats count by host, wp_category, _time, cloud_provider | rename _time as bucket_ts, wp_category as value'
    + ' | eval metric="abap_wp"';
['logserv_hostrole_aggregate', 'logserv_hostrole_backfill'].forEach((name) => {
    const search = keyOf(stanzaLines(SS, name), 'search') || '';
    check(`S1 [${name}] stores abap_wp by wp_category`, search.split(ARM).length === 2,
        `${search.split(ARM).length - 1} arm(s)`);
});
check('S2 no shipped search reads wp_type', !/\bwp_type\b/.test(SS), 'savedsearches.conf names wp_type');
['props.conf', 'transforms.conf', 'collections.conf'].forEach((f) => {
    check(`S3 ${f} names no wp_type`, !/\bwp_type\b/.test(read(path.join(DEF, f))), f);
});

/* ============================ Host Details ============================ */

const HD = read(path.join(HOME, 'dashboards', 'HostDetails.tsx'));
check('H1 Host Details reads abap_wp as wp_category on both arms',
    HD.indexOf("roleRead('abap_wp', 'wp_category')") !== -1 && HD.indexOf("roleReadRaw('abap_wp', 'wp_category')") !== -1,
    'roleRead / roleReadRaw of abap_wp');
check('H2 Host Details names the letter with wpCategoryNameEval and shows the name column',
    HD.indexOf("wpCategoryNameEval('wp_category', 'wp_category_name')") !== -1
    && HD.indexOf("colsForKey('wp_category_name', 'Trace Component')") !== -1, 'wpCategoryNameEval / colsForKey');
check('H2b both arms (rollup and sub-hour raw) append the name eval',
    HD.indexOf("roleRead('abap_wp', 'wp_category') + WP_NAME") !== -1
    && HD.indexOf("roleReadRaw('abap_wp', 'wp_category') + WP_NAME") !== -1, 'roleRead / roleReadRaw + WP_NAME');
check('H3 Host Details names no wp_type', !/\bwp_type\b/.test(HD), 'HostDetails.tsx names wp_type');

/* ===================================================================== */

if (wpFailures > 0) {
    process.stderr.write(`\nwpCategory.consistency-test: ${wpFailures} failure(s) of ${wpChecks}\n`);
    process.exit(1);
}
console.log(`wpCategory.consistency-test: OK (${wpChecks} checks)`);
