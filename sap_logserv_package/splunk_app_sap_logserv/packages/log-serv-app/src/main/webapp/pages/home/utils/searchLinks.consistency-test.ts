/**
 * Build-time consistency test for where the App sends users to Splunk's
 * search page and Job Inspector (utils/searchPage.ts, build 399).
 *
 * A customer whose site disables Splunk's Search app (one app per
 * department) found that every Open in Search link led to an error page:
 * the links opened /app/search/search. Since build 399 they open the search
 * page inside this app, which ships its own search view.
 *
 * What it pins:
 *  - L1: searchPage's app ID is the app's own ID in app.conf [package] id;
 *  - L2: Open in Search (panel toolbar) opens this app's search page, keeps
 *    a leading pipe, prepends `search` otherwise, and carries the time range;
 *  - L3: the Splunk Search drilldown builder opens the same page;
 *  - L4: the Inspect button opens the Job Inspector in this app's namespace;
 *  - L5: the AI Assistant's guidance-card next-step links (the hook's own
 *    buildSplunkSearchUrl) build their URL on SEARCH_PAGE_PATH, and the Run
 *    SPL chips (chat/AIAssistant.tsx, chat/ToolResultPanel.tsx) import
 *    drilldownUrls.buildSplunkSearchUrl (L3) and define no builder of their own;
 *  - L6: no source file outside the tests names the Search app's page or
 *    its Job Inspector path (/app/search/, /manager/search/): .ts .tsx .js
 *    .jsx .html .xml under webapp, plus every file under resources/splunk
 *    except lookups (confs, metadata, the intent map JSON, app.manifest);
 *    literal paths only, so L2 to L5 pin the builders by behaviour;
 *  - L7: the app ships a `search` view on Splunk's own search template, and
 *    metadata/default.meta keeps it unexported (export = none), so it
 *    changes nothing outside this app;
 *  - L8: the tooltips and labels of the Run SPL chips and the Data Doctor's
 *    open-in-search button name Splunk's search page, not the Search app.
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
const sp = require('./searchPage');
const du = require('./drilldownUrls');

const HOME = path.resolve(__dirname, '..');
const SPLUNK = path.resolve(__dirname, '../../../../resources/splunk');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let slFailures = 0;
let slChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    slChecks += 1;
    if (!ok) {
        slFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

const APP_CONF = read(path.join(SPLUNK, 'default/app.conf'));
const pkgId = (/^\[package\][^[]*?^id\s*=\s*(\S+)/m.exec(APP_CONF) || [])[1];
const PAGE = `/en-US/app/${pkgId}/search?q=`;
const qOf = (url: string): string => decodeURIComponent((/[?&]q=([^&]*)/.exec(url) || [])[1] || '');

// L1
check('L1 app id', !!pkgId && sp.SEARCH_LINK_APP === pkgId,
    `searchPage SEARCH_LINK_APP ${sp.SEARCH_LINK_APP} differs from app.conf [package] id ${pkgId}`);
check('L1 paths', sp.SEARCH_PAGE_PATH === `/en-US/app/${pkgId}/search`
    && sp.JOB_INSPECTOR_PATH === `/en-US/manager/${pkgId}/job_inspector`,
    `paths ${sp.SEARCH_PAGE_PATH} / ${sp.JOB_INSPECTOR_PATH}`);

// L2
const piped = du.buildOpenInSearchUrl('| tstats count where index=x by sourcetype', '-24h', 'now');
check('L2 page', piped.startsWith(PAGE), `Open in Search URL ${piped}`);
check('L2 pipe kept', qOf(piped) === '| tstats count where index=x by sourcetype', `q ${qOf(piped)}`);
check('L2 time', /&earliest=-24h&latest=now$/.test(piped), `time range ${piped}`);
const bare = du.buildOpenInSearchUrl('index=x sourcetype="a b"');
check('L2 search prepended', bare.startsWith(PAGE) && qOf(bare) === 'search index=x sourcetype="a b"', `bare ${bare}`);
check('L2 no time', !/earliest=|latest=/.test(bare), `no time range expected: ${bare}`);
const searched = du.buildOpenInSearchUrl('  search index=x  ');
check('L2 search kept', qOf(searched) === 'search index=x', `searched ${qOf(searched)}`);

// L3
const drill = du.buildSplunkSearchUrl('index=x error', '-7d@d', 'now');
check('L3 page', drill.startsWith(PAGE) && qOf(drill) === 'search index=x error'
    && /&earliest=-7d%40d&latest=now$/.test(drill), `drilldown URL ${drill}`);

// L4
const insp = du.buildJobInspectorUrl('scheduler__admin_c3BsdW5r__RMD5a1b2_at_1_2');
check('L4 inspector', insp === `/en-US/manager/${pkgId}/job_inspector?sid=scheduler__admin_c3BsdW5r__RMD5a1b2_at_1_2`,
    `inspector URL ${insp}`);

// L5
const hook = read(path.join(HOME, 'hooks/useAIAssistant.ts'));
const builder = (/const buildSplunkSearchUrl = [\s\S]*?\n};/.exec(hook) || [''])[0];
check('L5 hook builder', /return `\$\{SEARCH_PAGE_PATH\}\?\$\{params\.toString\(\)\}`;/.test(builder),
    'useAIAssistant buildSplunkSearchUrl must return `${SEARCH_PAGE_PATH}?${params.toString()}`');
check('L5 hook import', /import \{ SEARCH_PAGE_PATH \} from '\.\.\/utils\/searchPage';/.test(hook),
    'useAIAssistant must import SEARCH_PAGE_PATH from ../utils/searchPage');
for (const rel of ['components/ai/chat/AIAssistant.tsx', 'components/ai/chat/ToolResultPanel.tsx']) {
    const src = read(path.join(HOME, rel));
    check(`L5 chips ${rel}`, /import \{[^}]*\bbuildSplunkSearchUrl\b[^}]*\} from '(\.\.\/)+utils\/drilldownUrls';/.test(src)
        && !/(const|function)\s+buildSplunkSearchUrl\b/.test(src),
        `${rel} must import buildSplunkSearchUrl from utils/drilldownUrls and define no builder of its own`);
}

// L6
const walk = (dir: string, out: string[]): string[] => {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|js|jsx|html|xml)$/.test(name) && !/\.(consistency-)?test\./.test(name)) out.push(p);
    }
    return out;
};
const walkAll = (dir: string, out: string[]): string[] => {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
            if (name !== 'lookups') walkAll(p, out);
        } else if (/\.(conf|meta|json|manifest|xml|html|js|txt|spec)$/.test(name)) out.push(p);
    }
    return out;
};
const sources = walk(path.resolve(HOME, '../..'), [])
    .concat(walkAll(SPLUNK, []));
const offenders = sources.filter((p: string) => /\/app\/search\/|\/manager\/search\//.test(read(p)));
check('L6 no search-app links', offenders.length === 0,
    `files that still name /app/search/ or /manager/search/: ${offenders.map((p: string) => path.relative(HOME, p)).join(', ')}`);
check('L6 scanned', sources.length > 50, `only ${sources.length} source files scanned`);

// L7
const viewPath = path.join(SPLUNK, 'default/data/ui/views/search.xml');
const view = fs.existsSync(viewPath) ? read(viewPath) : '';
check('L7 view', /<view template="pages\/search\.html" type="html" isDashboard="False">/.test(view)
    && /<label>Search<\/label>/.test(view), `default/data/ui/views/search.xml: ${view || 'missing'}`);
const meta = read(path.join(SPLUNK, 'metadata/default.meta'));
const stanza = (/^\[views\/search\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(meta) || [])[1] || '';
check('L7 not exported', /^export\s*=\s*none\s*$/m.test(stanza),
    `metadata/default.meta [views/search] must say export = none: ${stanza || 'no stanza'}`);

// L8
const LABELS: Array<[string, string]> = [
    ['components/ai/chat/ChatMessage.tsx', 'title="Open this SPL on Splunk\'s search page (new tab)"'],
    ['components/ai/chat/ToolResultPanel.tsx', 'title="Open this SPL on Splunk\'s search page (new tab)"'],
    ['state/DiagnosticDrawerProvider.tsx', "'Open on the Splunk search page (new tab) over the diagnosed window"],
    ['state/DiagnosticDrawerProvider.tsx', 'aria-label="Open this SPL on Splunk\'s search page in a new tab"'],
];
for (const [rel, text] of LABELS) {
    check(`L8 ${rel}`, read(path.join(HOME, rel)).includes(text), `${rel} must say: ${text}`);
}
for (const rel of ['components/ai/chat/ChatMessage.tsx', 'components/ai/chat/ToolResultPanel.tsx', 'state/DiagnosticDrawerProvider.tsx']) {
    const shown = read(path.join(HOME, rel)).split('\n')
        .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /search app/i.test(l));
    check(`L8 no Search app ${rel}`, shown.length === 0, `${rel} shows "Search app": ${shown.join(' | ')}`);
}

if (slFailures > 0) {
    process.stderr.write(`searchLinks.consistency-test: ${slFailures} of ${slChecks} checks FAILED\n`);
    process.exit(1);
}
console.log(`searchLinks.consistency-test: ${slChecks} checks passed`);
