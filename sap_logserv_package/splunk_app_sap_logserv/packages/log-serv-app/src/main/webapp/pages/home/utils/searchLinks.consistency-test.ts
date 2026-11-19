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
 *    open-in-search button name Splunk's search page, not the Search app;
 *    no shown line of those files, PromptBrowser, PanelMeta, the hook or
 *    diagReport says "Search app", and no line at all (comments included)
 *    of the chat files, the Data Doctor drawer or diagReport does (build 400);
 *    "Search-app" with a hyphen counts as "Search app" in both checks;
 *  - L9: PanelMeta's Open in Search and Inspect buttons open
 *    openInNewTab(buildOpenInSearchUrl(spl, timeRange.earliest,
 *    timeRange.latest)) and openInNewTab(buildJobInspectorUrl(sid)), imported
 *    unaliased from utils/drilldownUrls, and PanelMeta declares no builder of
 *    its own (build 400);
 *  - L10: the Data Doctor drawer's open-in-search button opens
 *    openInNewTab(buildOpenInSearchUrl(openable, earliest, latest)), where
 *    openable is producerSplForOpenInSearch(spl) (the terminal outputlookup
 *    write removed) and the button renders only when openable !== null; every
 *    page the Data Doctor files (utils/diag*, utils/panelDiagnosis,
 *    state/Diagnostic*, dashboards/Diagnostics) open goes through a
 *    utils/drilldownUrls builder (build 400);
 *  - L11: outside utils/searchPage.ts no string in the code (string and
 *    template literals, JSX text, + chains, and an array of string literals
 *    joined with a string literal, such as ['', 'en-US', 'app', 'search',
 *    'search'].join('/'); comments are not code) names a
 *    search page path (/app/<x>/search, or a bare /search piece), a Job
 *    Inspector path or /manager/, so a hand-built URL that L6 does not see
 *    (this app's own path, or one split across pieces) fails too (build 400).
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
// A build-time test: typescript is a devDependency on purpose (L9-L11 parse the code).
// eslint-disable-next-line import/no-extraneous-dependencies
const ts = require('typescript');
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
// A hyphen counts as a space ("Search-app"), in shown lines and in comments alike (build 400 review).
const SEARCH_APP_RE = /search[\s-]app/i;
check('L8 the wording check sees "Search app" and "Search-app"', ['Open in the Search app', 'from the Search-app',
    'SEARCH APP'].every((s: string) => SEARCH_APP_RE.test(s)) && !SEARCH_APP_RE.test('the search page of this app'), '');
for (const rel of ['components/ai/chat/ChatMessage.tsx', 'components/ai/chat/ToolResultPanel.tsx',
    'components/ai/chat/PromptBrowser.tsx', 'components/PanelMeta.tsx', 'hooks/useAIAssistant.ts',
    'state/DiagnosticDrawerProvider.tsx', 'utils/diagReport.ts']) {
    const shown = read(path.join(HOME, rel)).split('\n')
        .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l) && SEARCH_APP_RE.test(l));
    check(`L8 no Search app ${rel}`, shown.length === 0, `${rel} shows "Search app": ${shown.join(' | ')}`);
}
// The hook keeps one history comment (what build 141 opened), so it is not here.
['components/ai/chat/ChatMessage.tsx', 'components/ai/chat/ToolResultPanel.tsx',
    'components/ai/chat/PromptBrowser.tsx', 'state/DiagnosticDrawerProvider.tsx', 'utils/diagReport.ts']
    .forEach((rel: string) => {
        const said = read(path.join(HOME, rel)).split('\n').filter((l: string) => SEARCH_APP_RE.test(l));
        check(`L8 comments ${rel}`, said.length === 0,
            `${rel} says a link opens the Search app (it opens this app's search page): ${said.join(' | ')}`);
    });

// L9-L11 read the code as a syntax tree, so comments never count.
const parse = (rel: string): any => ts.createSourceFile(rel, read(path.join(HOME, rel)), ts.ScriptTarget.Latest,
    true, /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const findAll = (root: any, pred: any): any[] => {
    const out: any[] = [];
    const visit = (n: any): void => {
        if (pred(n)) {
            out.push(n);
        }
        ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
};
const flatText = (sf: any, n: any): string => n.getText(sf).replace(/\s+/g, ' ');
/** The names a file imports, unaliased, from utils/drilldownUrls. */
const drilldownImports = (sf: any): string[] => {
    const names: string[] = [];
    sf.statements.forEach((st: any) => {
        if (!ts.isImportDeclaration(st) || !/^((\.\.\/)+utils\/|\.\/)drilldownUrls$/.test(st.moduleSpecifier.text)) {
            return;
        }
        const nb = st.importClause && st.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
            nb.elements.forEach((el: any) => {
                if (!el.propertyName) {
                    names.push(el.name.text);
                }
            });
        }
    });
    return names;
};
const URL_HELPERS = ['buildOpenInSearchUrl', 'buildSplunkSearchUrl', 'buildJobInspectorUrl', 'buildDashboardUrl',
    'buildHostDetailsUrl', 'buildResultsExportUrl', 'openInNewTab'];
/** Declarations that would shadow a utils/drilldownUrls helper. */
const ownHelpers = (sf: any): string[] => findAll(sf, (n: any) => (ts.isVariableDeclaration(n)
    || ts.isFunctionDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n))
    && !!n.name && ts.isIdentifier(n.name) && URL_HELPERS.indexOf(n.name.text) !== -1)
    .map((n: any) => n.name.text);
/** Every call that opens a page, and every assignment to a location. */
const openers = (sf: any, root: any): any[] => findAll(root, (n: any) => (ts.isCallExpression(n)
    && /^(openInNewTab|(window\.)?open|(window\.|document\.)?location\.(assign|replace))$/.test(n.expression.getText(sf)))
    || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && /(^|\.)location(\.href)?$/.test(n.left.getText(sf))));
/** A page opener of the form openInNewTab(<helper>(...)): the helper's call, else null. */
const helperCall = (sf: any, n: any, helpers: string[]): any => (ts.isCallExpression(n)
    && n.expression.getText(sf) === 'openInNewTab' && n.arguments.length === 1
    && ts.isCallExpression(n.arguments[0]) && helpers.indexOf(n.arguments[0].expression.getText(sf)) !== -1
    ? n.arguments[0] : null);
/** The button with this aria-label opens openInNewTab(fn(args)) and nothing else. */
const checkButton = (tag: string, rel: string, sf: any, label: string, fn: string, args: string[]): any => {
    const els = findAll(sf, (n: any) => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))
        && n.attributes.properties.some((a: any) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'aria-label'
            && !!a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === label));
    check(`${tag} button`, els.length === 1, `${rel}: expected one element with aria-label "${label}", found ${els.length}`);
    if (els.length !== 1) {
        return null;
    }
    const attr = els[0].attributes.properties.find((a: any) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'onClick');
    const handler = attr && attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
    const opened = handler ? openers(sf, handler) : [];
    const call = opened.length === 1 ? helperCall(sf, opened[0], [fn]) : null;
    check(`${tag} opens via ${fn}`, !!call,
        `${rel}: "${label}" must open openInNewTab(${fn}(...)) and nothing else; it opens `
        + `${opened.map((o: any) => flatText(sf, o)).join(' | ') || 'nothing'}`);
    if (!call) {
        return null;
    }
    const got = call.arguments.map((a: any) => a.getText(sf).replace(/\s+/g, ''));
    check(`${tag} args`, got.join(', ') === args.join(', '),
        `${rel}: ${fn}(${got.join(', ')}), expected ${fn}(${args.join(', ')})`);
    return els[0];
};

// L9
const PM = 'components/PanelMeta.tsx';
const pmSf = parse(PM);
const pmImports = drilldownImports(pmSf);
check('L9 PanelMeta imports', ['buildOpenInSearchUrl', 'buildJobInspectorUrl', 'openInNewTab']
    .every((n: string) => pmImports.indexOf(n) !== -1),
`${PM} must import buildOpenInSearchUrl, buildJobInspectorUrl and openInNewTab, unaliased, from utils/drilldownUrls: ${pmImports.join(', ')}`);
check('L9 PanelMeta no own helper', ownHelpers(pmSf).length === 0, `${PM} declares its own ${ownHelpers(pmSf).join(', ')}`);
checkButton('L9 Open in Search', PM, pmSf, 'Open in Search', 'buildOpenInSearchUrl',
    ['spl', 'timeRange.earliest', 'timeRange.latest']);
checkButton('L9 Inspect', PM, pmSf, 'Inspect search job', 'buildJobInspectorUrl', ['sid']);

// L10
const DD = 'state/DiagnosticDrawerProvider.tsx';
const ddSf = parse(DD);
const ddImports = drilldownImports(ddSf);
check('L10 Data Doctor imports', ['buildOpenInSearchUrl', 'openInNewTab'].every((n: string) => ddImports.indexOf(n) !== -1),
    `${DD} must import buildOpenInSearchUrl and openInNewTab, unaliased, from utils/drilldownUrls: ${ddImports.join(', ')}`);
const ddBtn = checkButton('L10 Data Doctor open', DD, ddSf, 'Open this SPL on Splunk\'s search page in a new tab',
    'buildOpenInSearchUrl', ['openable', 'earliest', 'latest']);
const openable = findAll(ddSf, (n: any) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'openable');
check('L10 write removed', openable.length === 1 && !!openable[0].initializer && ts.isCallExpression(openable[0].initializer)
    && openable[0].initializer.expression.getText(ddSf) === 'producerSplForOpenInSearch'
    && openable[0].initializer.arguments.map((a: any) => a.getText(ddSf)).join(',') === 'spl',
`${DD}: openable must be declared once, as producerSplForOpenInSearch(spl), so the opened SPL has no outputlookup write`);
let failClosed = false;
for (let p = ddBtn ? ddBtn.parent : null; p && !failClosed; p = p.parent) {
    failClosed = ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && flatText(ddSf, p.left) === 'openable !== null';
}
check('L10 fail closed', failClosed, `${DD}: the open-in-search button must render only under openable !== null && (...)`);
const DIAG_FILES = ([] as string[])
    .concat(fs.readdirSync(path.join(HOME, 'utils'))
        .filter((n: string) => /^(diag\w*|panelDiagnosis)\.ts$/.test(n)).map((n: string) => `utils/${n}`))
    .concat(fs.readdirSync(path.join(HOME, 'state'))
        .filter((n: string) => /^Diagnostic\w*\.tsx?$/.test(n)).map((n: string) => `state/${n}`))
    .concat(['dashboards/Diagnostics.tsx']);
let diagOpeners = 0;
DIAG_FILES.forEach((rel: string) => {
    const sf = parse(rel);
    const helpers = drilldownImports(sf).filter((n: string) => n !== 'openInNewTab');
    openers(sf, sf).forEach((o: any) => {
        diagOpeners += 1;
        check(`L10 Data Doctor link ${rel}`, !!helperCall(sf, o, helpers),
            `${rel}: ${flatText(sf, o)} must be openInNewTab(<a utils/drilldownUrls builder>(...))`);
    });
    check(`L10 no own helper ${rel}`, ownHelpers(sf).length === 0, `${rel} declares its own ${ownHelpers(sf).join(', ')}`);
});
check('L10 scanned', DIAG_FILES.length >= 10 && diagOpeners >= 1,
    `${DIAG_FILES.length} Data Doctor files, ${diagOpeners} links found (expected at least 10 files and 1 link)`);

// L11
const PATH_RES = [/\/app\/[^/\s'"`]*\/search(?![\w-])/, /^\/search(?:[?#]|$)/, /\/search\?/, /job_inspector/, /\/manager\//];
const isPlus = (n: any): boolean => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
const tplText = (n: any): string => n.head.text + n.templateSpans.map((s: any) => `<x>${s.literal.text}`).join('');
const isText = (n: any): boolean => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
/** The text of `[...].join(sep)` when every element and the separator are string literals (the separator ','
 *  when none is given, as Array.prototype.join does), else null. */
const joinText = (n: any): string | null => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'join') {
        return null;
    }
    let arr = n.expression.expression;
    while (ts.isParenthesizedExpression(arr)) {
        arr = arr.expression;
    }
    if (!ts.isArrayLiteralExpression(arr) || !arr.elements.every((e: any) => isText(e)) || n.arguments.length > 1
        || (n.arguments.length === 1 && !isText(n.arguments[0]))) {
        return null;
    }
    const sep = n.arguments.length === 1 ? n.arguments[0].text : ',';
    return arr.elements.map((e: any) => e.text).join(sep);
};
const plusText = (n: any): string => {
    if (isPlus(n)) {
        return plusText(n.left) + plusText(n.right);
    }
    if (ts.isParenthesizedExpression(n)) {
        return plusText(n.expression);
    }
    if (isText(n)) {
        return n.text;
    }
    const joined = joinText(n);
    if (joined !== null) {
        return joined;
    }
    return ts.isTemplateExpression(n) ? tplText(n) : '<x>';
};
/** Every string the code holds: literals, templates (<x> for each substitution), JSX text, + chains, and the
 *  joins of an array of string literals (build 400 review: a path split into pieces and joined with '/'). */
const codeStrings = (sf: any): string[] => {
    const out: string[] = [];
    findAll(sf, (n: any) => {
        if (isText(n) || ts.isJsxText(n)) {
            out.push(n.text);
        } else if (ts.isTemplateExpression(n)) {
            out.push(tplText(n));
        }
        const joined = joinText(n);
        if (joined !== null) {
            out.push(joined);
        }
        if (isPlus(n) && !isPlus(n.parent)) {
            out.push(plusText(n));
        }
        return false;
    });
    return out;
};
// The forms L11 must see, each building /en-US/app/search/search (the audit's S3b first), and one it must not flag.
const L11_CASES: Array<[string, boolean]> = [
    ["openInNewTab(['', 'en-US', 'app', 'search', 'search'].join('/') + '?q=' + encodeURIComponent(spl));", true],
    ["const u = ['', 'en-US', 'app', 'search', 'search'].join('/');", true],
    ["const u = (['', 'en-US', 'manager', 'x', 'job_inspector']).join('/');", true],
    ["const u = '/en-US/app/' + 'search' + '/search?q=' + q;", true],
    // The template is spelled in pieces so this file holds no placeholder in a plain string.
    [['const u = `/en-US/app/$', '{app}/search?q=$', '{q}`;'].join(''), true],
    ["const t = ['Exclude', 'x'].join(', ');", false],
];
const l11Wrong = L11_CASES.filter(([src, flagged]) => {
    const sf = ts.createSourceFile('case.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return codeStrings(sf).some((s: string) => PATH_RES.some((re: RegExp) => re.test(s))) !== flagged;
}).map(([src]) => src);
check('L11 the known forms (an array joined with \'/\' among them) are seen, and a plain join is not', l11Wrong.length === 0,
    `wrong: ${l11Wrong.join(' | ')}`);
const codeFiles = walk(path.resolve(HOME, '../..'), []).filter((p: string) => /\.(ts|tsx|js|jsx)$/.test(p)
    && path.resolve(p) !== path.resolve(HOME, 'utils/searchPage.ts'));
const handBuilt: string[] = [];
codeFiles.forEach((p: string) => {
    const sf = ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true,
        /\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    codeStrings(sf).filter((s: string) => PATH_RES.some((re: RegExp) => re.test(s)))
        .forEach((s: string) => handBuilt.push(`${path.relative(HOME, p)}: ${JSON.stringify(s.slice(0, 100))}`));
});
check('L11 no hand-built search links', handBuilt.length === 0,
    `only utils/searchPage.ts may name the search page or Job Inspector path: ${handBuilt.join(' ; ')}`);
check('L11 scanned', codeFiles.length > 50, `only ${codeFiles.length} code files scanned`);

if (slFailures > 0) {
    process.stderr.write(`searchLinks.consistency-test: ${slFailures} of ${slChecks} checks FAILED\n`);
    process.exit(1);
}
console.log(`searchLinks.consistency-test: ${slChecks} checks passed`);
