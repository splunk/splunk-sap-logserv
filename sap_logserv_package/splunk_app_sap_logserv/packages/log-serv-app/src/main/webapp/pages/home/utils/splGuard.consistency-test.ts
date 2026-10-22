/**
 * Build-time consistency test for the AI Assistant's ad-hoc SPL allow-list
 * (App build 377): utils/splLexer.ts, `analyzeAdHocSpl` and the search-parser
 * agreement in utils/splGuard.ts, and components/ai/splParserCheck.ts.
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - A. THE COMMAND LIST. ALLOWED_SPL_COMMANDS is exactly the reviewed list
 *    (an addition must be reviewed here), shares nothing with the denylist,
 *    is a subset of the Tier 2 reader's KNOWN_COMMANDS (so the reader reads
 *    every allowed command in full), and holds every command the catalog and
 *    nextStep SPL use, subsearches included. Both system primers list it word
 *    for word, in one string literal each. `union` is off it (user decision,
 *    App build 377: Splunk's search parser reports a union rewritten - as
 *    search ... | append [...] or as multisearch, live probe P2 - so the
 *    parser agreement would refuse every one); a union is refused before the
 *    parser is asked, by name, with a reason that says to use append.
 *  - B. THE LOOKUP LIST is this App's lookup stanzas in default/transforms.conf
 *    (a `filename` or a `collection`) minus the four excluded ones, exactly.
 *  - C. THE MACRO DEFINITIONS the lexer expands are the last `definition` of
 *    each default/macros.conf stanza, and the names are ALLOWED_SPL_MACROS.
 *  - D. THE CATALOG: every catalog search and every nextStep SPL passes, and
 *    the lexer splits each into the same top-level commands as the Tier 2
 *    reader (vendorColumnText.readerCommandNames) - and so does every query
 *    of the pass corpus. The tool description's example passes.
 *  - E. THE RULES: each rule refuses its probes with its operator and names
 *    the command, lookup or macro it is about; the denylist still refuses
 *    first, with its own operator; the pass corpus passes.
 *  - F. THE REASONS reach the AI vendor unchanged (vendorRefusalText) and
 *    under its cap; a refusal's `command` is a safe name.
 *  - G. THE LEXER: tokens, problems, the command tree, a hostile nesting
 *    (no recursion, `too_deep`).
 *  - The security review of build 377 (E2 / G2 / H2 / H6 probes): a backslash
 *    outside double quotes (Splunk reads `\|` as no command boundary, so an
 *    appendpipe group could really be an unscoped filter subsearch), a macro
 *    glued to other text (Splunk expands it as text), and a lookup whose name
 *    a quoted option value or a glued token could make another one.
 *  - H. THE PARSER AGREEMENT (U13 = B): Splunk's search parser must read the
 *    query the same way - a nested command not on the list, a different
 *    top-level list, a data macro that expands to something else, an index
 *    term other than the LogServ index all refuse (`parser_mismatch`); HTTP
 *    400 is `parser_rejected`; any other failure, a timeout, an abort, a body
 *    that is not JSON or has no command list is `parser_unavailable` (fail
 *    closed); a local refusal never calls the parser.
 *  - I. THE LOOKUP NAMES IN THE PARSER'S REPLY (App build 378): the lookup of
 *    every top-level `lookup` / `inputlookup` is read again from the raw
 *    arguments Splunk's parser reports (`parserLookupName`; the shapes live
 *    probe P2 recorded are pinned verbatim) and must be one of the App's; a
 *    shape that cannot be read refuses (`parser_mismatch`, naming the
 *    command). Every catalog, nextStep and pass-corpus query with a top-level
 *    lookup agrees, its raw arguments built the way P2 showed Splunk builds
 *    them; a lookup inside a subsearch stays the lexer's to check.
 *
 * Async (the parser call is), so it exports `run()` for the async chain of
 * bin/check-diagnostics.js.
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void } };

const fs = require('fs');
const path = require('path');
const sg = require('./splGuard');
const lx = require('./splLexer');
const vc = require('./vendorColumnText');
const ve = require('./vendorErrorText');
const pc = require('../components/ai/splParserCheck');

const HOME = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.resolve(__dirname, '../../../../resources/splunk/default');

const M = '`sap_logserv_idx_macro`';

/** The reviewed allow-list. An addition is a review: change it here and in the primers together. */
const REVIEWED_COMMANDS = [
    'search', 'where', 'eval', 'stats', 'eventstats', 'streamstats', 'tstats', 'chart', 'timechart', 'top', 'rare',
    'sort', 'head', 'tail', 'dedup', 'reverse', 'table', 'fields', 'rename', 'fillnull', 'filldown', 'bin', 'bucket',
    'rex', 'regex', 'spath', 'lookup', 'inputlookup', 'makeresults', 'addinfo', 'transaction', 'convert', 'iplocation',
    'strcat', 'xyseries', 'untable', 'transpose', 'fieldsummary', 'addtotals', 'addcoltotals', 'makemv', 'nomv',
    'mvcombine', 'append', 'appendcols', 'join', 'appendpipe',
];

/** Left out on purpose (the design's list, and union since P2); none of them may ever be on the allow-list. */
const LEFT_OUT = ['fieldformat', 'foreach', 'map', 'mvexpand', 'multisearch', 'set', 'uniq', 'noop', 'rangemap', 'fit',
    'apply', 'from', 'datamodel', 'pivot', 'metadata', 'metasearch', 'loadjob', 'inputcsv', 'eventcount', 'dbinspect',
    'return', 'format', 'rest', 'savedsearch', 'collect', 'outputlookup', 'delete', 'script', 'sendemail', 'union'];

/**
 * The three union shapes of the live parser probe P2 (corpus extra#6..#8), each reported by Splunk's search
 * parser as other commands (search, stats, append / multisearch, stats / search, stats, append, stats): refused
 * locally now, by name, before the parser is asked.
 */
const P2_UNION_SHAPES = [
    `| union [search ${M} sourcetype=a | stats count] [| inputlookup logserv_mc_rollup | stats count]`,
    `| union [search ${M} sourcetype=a] [search ${M} sourcetype=b] | stats count by sourcetype`,
    `| union [search ${M} sourcetype=a | stats count by host] [search ${M} sourcetype=b | stats count by host] | stats sum(count) by host`,
];

const EXCLUDED = ['logserv_backfill_stage', 'logserv_diag_platform_snapshot', 'logserv_diag_reports',
    'splunk_for_sap_logserv_assets', 'splunk_for_sap_logserv_identities'];

/** Queries the allow-list must pass (beyond the catalog). */
const PASS: string[] = [
    `${M} | stats count by host`,
    `search ${M} | stats count`,
    `${M} sourcetype=sap:hana:audit status!="SUCCESSFUL" | stats count by executing_user | sort -count`,
    `${M} earliest=-24h latest=now | stats count`,
    `${M} (sourcetype=a OR sourcetype=b) | stats count`,
    `${M} NOT sourcetype=x | stats count`,
    `| tstats count WHERE ${M} by sourcetype`,
    `${M} | stats count | tstats append=t prestats=t count where ${M} by host`,
    '| inputlookup logserv_mc_rollup | stats sum(count) as n',
    '| inputlookup append=t max=10 logserv_topology_edges where type="rfc"',
    '| makeresults | eval x=1',
    // what union did, with append (the refusal of a union says to write it this way)
    `${M} sourcetype=a | stats count by host | append [search ${M} sourcetype=b | stats count by host] | stats sum(count) by host`,
    `${M} [search ${M} sourcetype=x | stats count by host | fields host] | stats count`,
    `${M} [| inputlookup logserv_hostdetails_rollup | table host] | stats count`,
    `${M} | stats count by action | appendpipe [stats sum(count) as count | eval action="TOTAL"]`,
    `${M} | join type=left host [| inputlookup logserv_hostdetails_rollup | stats sum(count) as vol by host]`,
    `${M} | append [| makeresults | eval x=1]`,
    `${M} | appendcols [search ${M} sourcetype=y | stats count as y]`,
    `${M} | timechart span=1h count by host`,
    `${M} | top 10 uri`,
    `${M} | rare limit=5 user`,
    `${M} | \`sap_logserv_cloud_provider_default_macro\` | stats count by cloud_provider`,
    `${M} | lookup logserv_ti_malicious_ips ip AS dest OUTPUT category | stats count by category`,
    `${M} | eval 'User Name'=user | stats count by "User Name"`,
    `${M} | bucket _time span=1h | stats count by _time`,
    `${M} | rex field=_raw "took=(?<ms>\\d+)" | stats avg(ms) AS ms`,
    `${M} | eval x="don't" | table x`,
    `${M} | where like(uri, "%[x]%") | head 5`,
    `${M} | transaction host maxspan=5m | stats count`,
    `${M} | stats count by host | xyseries host count count | transpose`,
    `${M} | spath input=j path=a.b | fillnull value=0 | filldown x | dedup host | reverse | tail 5`,
    `${M} | iplocation src_ip | strcat a "-" b c | convert ctime(t) | addinfo | addtotals | addcoltotals`,
    `${M} | makemv delim="," x | nomv x | mvcombine y | fieldsummary`,
    `${M} | stats count by host | untable host f v | regex host="^a" | rename host AS h | table h`,
    `${M} | eventstats count | streamstats count | chart count by host | sort -count | head 5 | fields - x`,
    // security review of build 377: a macro may touch a bracket; a backslash inside double quotes is data
    `${M} | append [search ${M}]`,
    `${M} | append [${M} | stats count by host]`,
    `${M} | where match(uri, "a\\|b") | stats count`,
];

/** Queries the allow-list (or the denylist before it) must refuse: [query, operator, command]. */
const REFUSE: Array<[string, string, string | undefined]> = [
    // data scope
    ['index=main | stats count', 'index_not_allowed', 'index'],
    ['| tstats count where index=main', 'index_not_allowed', 'index'],
    [`${M} OR index=main`, 'index_not_allowed', 'index'],
    [`${M} OR sourcetype=x`, 'index_not_allowed', 'sap_logserv_idx_macro'],
    [`sourcetype=x OR ${M}`, 'index_not_allowed', 'sap_logserv_idx_macro'],
    [`NOT ${M} sourcetype=x`, 'index_not_allowed', 'sap_logserv_idx_macro'],
    [`${M} | Index=main`, 'index_not_allowed', 'index'],
    [`${M} sourcetype=x index::main`, 'index_not_allowed', 'index'],
    [`${M} index IN (main)`, 'index_not_allowed', 'index'],
    [`${M} index!=main`, 'index_not_allowed', 'index'],
    [`${M} "index"=main`, 'index_not_allowed', 'index'],
    [`${M} [search index=_audit | fields user]`, 'index_not_allowed', 'index'],
    [`${M} | append [search index=main]`, 'index_not_allowed', 'index'],
    ['`sap_logserv_audit_idx_macro` | stats count', 'index_not_allowed', 'sap_logserv_audit_idx_macro'],
    [`${M} | append [search \`sap_logserv_audit_idx_macro\`]`, 'index_not_allowed', 'sap_logserv_audit_idx_macro'],
    // commands
    [`${M} | fit DensityFunction count`, 'command_not_allowed', 'fit'],
    [`${M} | apply m`, 'command_not_allowed', 'apply'],
    [`${M} | foreach * [eval x=1]`, 'command_not_allowed', 'foreach'],
    [`${M} | fieldformat x=1`, 'command_not_allowed', 'fieldformat'],
    [`${M} | mvexpand x`, 'command_not_allowed', 'mvexpand'],
    [`${M} | rangemap field=count low=0-10`, 'command_not_allowed', 'rangemap'],
    ['| datamodel Authentication', 'command_not_allowed', 'datamodel'],
    ['| metadata type=hosts', 'command_not_allowed', 'metadata'],
    ['| inputcsv x.csv', 'command_not_allowed', 'inputcsv'],
    ['| eventcount index=main', 'index_not_allowed', 'index'],
    [`${M} | some_custom_cmd x=1`, 'command_not_allowed', 'some_custom_cmd'],
    [`${M} [search ${M} | stats count by host | return host]`, 'command_not_allowed', 'return'],
    [`${M} [search ${M} | stats count by host | fields host | format]`, 'command_not_allowed', 'format'],
    [`${M} | | stats count`, 'command_not_allowed', '(unnamed)'],
    [`${M} | "stats" count`, 'command_not_allowed', '(unnamed)'],
    [`${M} | appendpipe [rangemap field=count]`, 'command_not_allowed', 'rangemap'],
    // query start
    ['| rex field=_raw "x"', 'query_start', 'rex'],
    ['search "[DELETE]"', 'query_start', '(unnamed)'],
    ['sourcetype=x | stats count', 'query_start', 'sourcetype'],
    // the data macro anywhere but first: its position is refused before the start rule
    [`sourcetype=x ${M} | stats count`, 'macro_position', 'sap_logserv_idx_macro'],
    [`( ${M} ) | stats count`, 'macro_position', 'sap_logserv_idx_macro'],
    ['( sourcetype=x ) | stats count', 'query_start', '(unnamed)'],
    [`${M} | stats count | tstats append=t prestats=t count where sourcetype=x`, 'query_start', 'tstats'],
    ['| tstats count by host', 'query_start', 'tstats'],
    [`${M} | append [| rex field=_raw "x"]`, 'query_start', 'rex'],
    [`${M} | join host [sourcetype=x | fields host]`, 'query_start', 'sourcetype'],
    // lookups
    ['| inputlookup logserv_ai_models', 'lookup_not_allowed', 'logserv_ai_models'],
    ['| inputlookup logserv_diag_reports', 'lookup_not_allowed', 'logserv_diag_reports'],
    ['| inputlookup splunk_for_sap_logserv_identities', 'lookup_not_allowed', 'splunk_for_sap_logserv_identities'],
    ['| inputlookup x.csv', 'lookup_not_allowed', 'x.csv'],
    ['| inputlookup "logserv_mc_rollup"', 'lookup_not_allowed', '(unnamed)'],
    [`${M} | lookup customer_hr_lookup user OUTPUT ssn`, 'lookup_not_allowed', 'customer_hr_lookup'],
    [`${M} | appendpipe [inputlookup customer_hr]`, 'lookup_not_allowed', 'customer_hr'],
    [`${M} | eval x=lookup("logserv_mc_rollup", json_object("a",1))`, 'eval_lookup', 'lookup'],
    // whitespace between the function name and its parenthesis is the same call
    [`${M} | eval x=lookup ("identities_lookup", json_object("identity", user), json_array("email")) | stats count by x`, 'eval_lookup', 'lookup'],
    [`${M} | where isnotnull(lookup\n("t", json_object("a", user), json_array("b")))`, 'eval_lookup', 'lookup'],
    [`${M} | eval x = LOOKUP\t("t", json_object("a", 1))`, 'eval_lookup', 'lookup'],
    [`${M} | eval x=if(a, lookup ("t", json_object("a", 1)), 0)`, 'eval_lookup', 'lookup'],
    // subsearches
    [`${M} [search ${M} | stats count by host | fields search]`, 'subsearch_fields', 'fields'],
    [`${M} [search ${M} | stats count by host | fields query]`, 'subsearch_fields', 'fields'],
    [`${M} [search ${M} | stats count by host]`, 'subsearch_fields', 'stats'],
    [`${M} [search ${M} | fields *]`, 'subsearch_fields', 'fields'],
    [`${M} | stats count [search ${M} | fields host]`, 'subsearch_not_allowed', 'stats'],
    [`${M} | where [search ${M} | fields host]`, 'subsearch_not_allowed', 'where'],
    [`${M} | appendpipe [search ${M}] [search ${M}]`, 'subsearch_not_allowed', 'appendpipe'],
    // an appendpipe group starts with a command, never with the macro (the primers say so)
    [`${M} | stats count | appendpipe [search ${M} | stats count]`, 'macro_position', 'sap_logserv_idx_macro'],
    // union is off the allow-list (P2: Splunk's parser reports it rewritten): refused by name, wherever it stands
    ['| union datamodel:Authentication', 'command_not_allowed', 'union'],
    [`| union [search ${M}] some_dataset`, 'command_not_allowed', 'union'],
    [P2_UNION_SHAPES[0], 'command_not_allowed', 'union'],
    [P2_UNION_SHAPES[1], 'command_not_allowed', 'union'],
    [P2_UNION_SHAPES[2], 'command_not_allowed', 'union'],
    [`| UNION [search ${M} sourcetype=a] [search ${M} sourcetype=b]`, 'command_not_allowed', 'union'],
    [`${M} | union [search ${M} sourcetype=b]`, 'command_not_allowed', 'union'],
    [`${M} | append [| union [search ${M} sourcetype=a] [search ${M} sourcetype=b]] | stats count`, 'command_not_allowed', 'union'],
    [`${M} | stats count | appendpipe [union [search ${M}]]`, 'command_not_allowed', 'union'],
    [`${M} ${'[search '.repeat(9)}${M}${']'.repeat(9)}`, 'subsearch_not_allowed', undefined],
    // macros
    [`${M} | stats count | eval x="\`sap_logserv_idx_macro\`"`, 'macro_position', undefined],
    [`${M} | stats count by host | where host=${M}`, 'macro_position', 'sap_logserv_idx_macro'],
    [`${M} ${M} | stats count`, 'macro_position', 'sap_logserv_idx_macro'],
    // quoting and brackets
    [`${M} don't | stats count`, 'ambiguous_single_quote', undefined],
    [`${M} | where 'a|b'=1`, 'ambiguous_single_quote', undefined],
    [`${M} | eval x='a[b' | table x`, 'ambiguous_single_quote', undefined],
    [`${M} | rename user AS w | stats count by w | where w!="won't" | eval z='`, 'ambiguous_single_quote', undefined],
    [`${M} | stats count | ]`, 'unbalanced_bracket', undefined],
    [`${M} [search ${M} | fields host`, 'unbalanced_bracket', undefined],
    // security review of build 377: a backslash outside double quotes. Splunk passes `\|` to the command as a
    // literal pipe, so the bracket after it belongs to the search before it - an unscoped filter subsearch the
    // lexer would otherwise have checked as an appendpipe group.
    [`${M} | stats count by host | append [search ${M} | stats count by host | search host=* \\| appendpipe [search sourcetype=WinEventLog:Security | stats count by user | fields user]]`, 'escaped_outside_quotes', undefined],
    [`${M} | append [search ${M} host=* \\| appendpipe [search sourcetype=WinEventLog:Security | fields user]] | stats count`, 'escaped_outside_quotes', undefined],
    [`${M} host=* \\| appendpipe [search sourcetype=WinEventLog:Security | fields user] | stats count`, 'escaped_outside_quotes', undefined],
    [`${M} [search ${M} | stats count by host | search host=* \\| appendpipe [search sourcetype=x | fields host] | fields host] | stats count`, 'escaped_outside_quotes', undefined],
    [`${M} host=a\\[b | stats count`, 'escaped_outside_quotes', undefined],
    [`${M} | eval x='a\\' | stats count`, 'ambiguous_single_quote', undefined],
    // a macro glued to other text: Splunk expands it as text, so the glued text joins the index term
    [`${M}* | stats count by index`, 'macro_position', 'sap_logserv_idx_macro'],
    [`| tstats count where${M} by index`, 'macro_position', 'sap_logserv_idx_macro'],
    [`| tstats count where ${M}* by index`, 'macro_position', 'sap_logserv_idx_macro'],
    [`${M} | append [search ${M}_archive | stats count by index]`, 'macro_position', 'sap_logserv_idx_macro'],
    [`search${M} | stats count`, 'macro_position', 'sap_logserv_idx_macro'],
    [`${M} | stats count | \`sap_logserv_cloud_provider_default_macro\`x`, 'macro_position', 'sap_logserv_cloud_provider_default_macro'],
    // the lookup name: no quoted option value before it, nothing glued to it
    [`${M} | lookup event_time_field='x logserv_diag_reports report_id ' logserv_mc_rollup host`, 'lookup_not_allowed', '(unnamed)'],
    ['| inputlookup logserv_mc_rollup"_x"', 'lookup_not_allowed', '(unnamed)'],
    ['| inputlookup max="5" logserv_mc_rollup', 'lookup_not_allowed', '(unnamed)'],
    // the denylist first, with its own operator
    ['| makeresults | eval x=1 | collect index=main', 'collect', 'collect'],
    [`${M} | map search="search x"`, 'map', 'map'],
    ['| loadjob savedsearch=x', 'savedsearch', 'savedsearch'],
    [`${M} | append [| rest /services]`, 'rest', 'rest'],
    [`${M} | lookup dnslookup clientip`, 'external_lookup', undefined],
    [`${M} \`\`\` c \`\`\` | stats count`, 'inline_comment', undefined],
    // a macro the App does not define is named as the AI wrote it; the `macro` command is `macro`
    [`${M} | \`evil\``, 'macro', 'evil'],
    [`${M} | \`customer_hr_macro(1, 2)\` | stats count`, 'macro', 'customer_hr_macro'],
    [`${M} | \`bad name\` | stats count`, 'macro', '(unnamed)'],
    [`${M} | \`sap_logserv_idx_macro \` | stats count`, 'macro', '(unnamed)'],
    [`${M} | macro foo`, 'macro', 'macro'],
    [`${M} | macro foo | \`evil\``, 'macro', 'macro'],
    [`${M} | fit DensityFunction x into app:m`, 'fit_into', undefined],
    ['', 'query_start', undefined],
    ['   ', 'query_start', undefined],
];

/** Walk a pipeline tree: every command name, subsearch groups included. */
const allCommands = (p: any, firstIsCommand: boolean, out: string[]): string[] => {
    p.commands.forEach((c: any, i: number) => {
        const name = lx.commandName(p, i, firstIsCommand);
        out.push(name);
        c.groups.forEach((g: any) => allCommands(g, name === 'appendpipe', out));
    });
    return out;
};

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (name: string, cond: boolean, detail: string): void => {
        checks += 1;
        if (!cond) {
            failures += 1;
            process.stderr.write(`FAIL ${name}: ${detail}\n`);
        }
    };

    const intentMap = JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, 'data/mcp/logserv_intent_map.json'), 'utf8'));
    const catalog: Array<{ savedSearch: string; spl: string }> = intentMap.prompts;
    const nextSteps: string[] = [];
    catalog.forEach((p: any) => (p.nextSteps || []).forEach((s: any) => {
        if (s && typeof s === 'object' && typeof s.spl === 'string') nextSteps.push(s.spl);
    }));
    const hookSrc: string = fs.readFileSync(path.join(HOME, 'hooks/useAIAssistant.ts'), 'utf8').replace(/\r\n/g, '\n');

    /* ============================ A. the command list ============================ */
    const allowed: string[] = Array.from(sg.ALLOWED_SPL_COMMANDS);
    check('A1 ALLOWED_SPL_COMMANDS is the reviewed list', JSON.stringify(allowed) === JSON.stringify(REVIEWED_COMMANDS),
        JSON.stringify(allowed));
    check('A2 no command twice', new Set(allowed).size === allowed.length, '');
    const denied = new Set<string>([...sg.FORBIDDEN_SPL_COMMANDS, ...sg.FORBIDDEN_SPL_WORDS, ...sg.EXTERNAL_LOOKUPS]);
    const both = allowed.filter((c) => denied.has(c));
    check('A3 no allowed command is on the denylist', both.length === 0, both.join(', '));
    const unread = allowed.filter((c) => !vc.KNOWN_COMMANDS.has(c));
    check('A4 every allowed command is one the Tier 2 reader reads', unread.length === 0, unread.join(', '));
    const leftIn = LEFT_OUT.filter((c) => allowed.indexOf(c) !== -1);
    check('A5 none of the commands left out on purpose is allowed', leftIn.length === 0, leftIn.join(', '));
    const used = new Set<string>();
    for (const q of catalog.map((p) => p.spl).concat(nextSteps)) {
        const l = lx.lexSpl(q);
        if (l.ok) allCommands(l.pipeline, false, []).forEach((c) => used.add(c));
        else check(`A6 the lexer reads the catalog SPL: ${q.slice(0, 60)}`, false, l.problem);
    }
    const usedNot = Array.from(used).filter((c) => allowed.indexOf(c) === -1);
    check('A6 every command the catalog and nextStep SPL use is allowed', used.size >= 20 && usedNot.length === 0,
        `${used.size} used; not allowed [${usedNot.join(', ')}]`);
    const listLines = hookSrc.match(/^ {4}'Allowed commands: ([a-z, ]+)\.\\n' \+$/gm) || [];
    const listed = listLines.map((l) => /'Allowed commands: ([a-z, ]+)\./.exec(l)![1].split(', '));
    check('A7 both primers list the allowed commands word for word, in one literal each', listLines.length === 2
        && listed.every((x) => JSON.stringify(x) === JSON.stringify(allowed)),
    `${listLines.length} literal(s): ${JSON.stringify(listed)}`);
    check('A8 both primers carry the allow-list block', (hookSrc.match(/=== AD-HOC SPL — THE ALLOW-LIST \(ENFORCED\) ===/g) || []).length === 2
        && hookSrc.indexOf('READ-ONLY OPERATORS ONLY') === -1, '');
    // The start rule as the lexer applies it: every append / appendcols / join arm and every filter
    // subsearch starts like the query, an appendpipe group with a command (E2 refuses the macro there).
    const startLines = hookSrc.split('\n').map((l) => l.trim());
    const nStart = startLines.filter((l) => l === '`| makeresults. Start every append, appendcols or join arm and ` +').length;
    const nPipe = startLines.filter((l) => l === '`with a command (stats, eval, ...), never with the macro. Every tstats ` +').length;
    check('A9 both primers: arms start like the query, an appendpipe group with a command, never the macro',
        nStart === 2 && nPipe === 2 && hookSrc.indexOf('Start the query, and every subsearch, with') === -1, `${nStart} / ${nPipe}`);
    // union (P2): off the list, so neither primer may advertise it as a start, an arm or a subsearch host, and both
    // steer the model to append.
    const nAppend = startLines.filter((l) => l === '`names the macro right after WHERE. To combine two searches, use ` +').length;
    const nUnionOff = startLines.filter((l) => l === '`append; union is not on the list (Splunk rewrites a union before ` +').length;
    const nHosts = startLines.filter((l) => l === '`<names>, or in append, appendcols, join and appendpipe.\\n` +').length;
    const unionLines = startLines.filter((l) => /\bunion\b/i.test(l) && l.indexOf('union is not on the list') === -1
        && l.indexOf('rewrites a union before') === -1);
    check('A10 both primers: union is off the list, append combines two searches; no other line names union',
        nAppend === 2 && nUnionOff === 2 && nHosts === 2 && unionLines.length === 0,
        `${nAppend} / ${nUnionOff} / ${nHosts}; other union lines: ${JSON.stringify(unionLines)}`);
    const instead: Record<string, string> = sg.COMMAND_INSTEAD || {};
    check('A11 union is no subsearch host, no start command and has no operator of its own; its refusal says to use append',
        sg.SUBSEARCH_HOSTS.indexOf('union') === -1 && sg.START_COMMANDS.indexOf('union') === -1
        && sg.ALLOW_LIST_OPERATORS.indexOf('union_dataset') === -1 && sg.OPERATOR_UNION_DATASET === undefined
        && Object.keys(instead).every((c: string) => allowed.indexOf(c) === -1)
        && JSON.stringify(Object.keys(instead)) === '["union"]'
        && /rewrites a union/.test(String(instead.union))
        && /use append: <first search> \| append \[search `sap_logserv_idx_macro` \.\.\.\]\.$/.test(String(instead.union)),
    JSON.stringify(instead));

    /* ============================ B. the lookup list ============================ */
    const tf: string = fs.readFileSync(path.join(DEFAULT_DIR, 'transforms.conf'), 'utf8').replace(/\r\n/g, '\n');
    const stanzaKeys: Record<string, Set<string>> = {};
    let cur: string | null = null;
    tf.split('\n').forEach((line) => {
        const h = /^\[(.+)\]\s*$/.exec(line.trim());
        if (h) {
            cur = h[1];
            stanzaKeys[cur] = new Set();
            return;
        }
        const k = /^([A-Za-z_]+)\s*=/.exec(line);
        if (k && cur !== null) stanzaKeys[cur].add(k[1]);
    });
    const lookups = Object.keys(stanzaKeys).filter((s) => stanzaKeys[s].has('filename') || stanzaKeys[s].has('collection')).sort();
    const want = lookups.filter((l) => EXCLUDED.indexOf(l) === -1);
    const allowedLookups: string[] = Array.from(sg.ALLOWED_SPL_LOOKUPS);
    check('B1 ALLOWED_SPL_LOOKUPS = the transforms.conf lookups minus the excluded ones', lookups.length >= 40
        && JSON.stringify(allowedLookups.slice().sort()) === JSON.stringify(want),
    `missing [${want.filter((l) => allowedLookups.indexOf(l) === -1).join(', ')}], extra [${allowedLookups.filter((l) => want.indexOf(l) === -1).join(', ')}]`);
    check('B2 EXCLUDED_SPL_LOOKUPS is the reviewed list, every one a lookup of the App', JSON.stringify(Array.from(sg.EXCLUDED_SPL_LOOKUPS))
        === JSON.stringify(EXCLUDED) && EXCLUDED.every((l) => lookups.indexOf(l) !== -1), JSON.stringify(sg.EXCLUDED_SPL_LOOKUPS));
    const exclRefused = EXCLUDED.filter((l) => sg.analyzeAdHocSpl(`| inputlookup ${l}`).operator !== 'lookup_not_allowed');
    check('B3 every excluded lookup is refused', exclRefused.length === 0, exclRefused.join(', '));
    const allowPass = allowedLookups.filter((l) => sg.analyzeAdHocSpl(`| inputlookup ${l} | stats count`).blocked
        || sg.analyzeAdHocSpl(`${M} | lookup ${l} a OUTPUT b | stats count by b`).blocked);
    check('B4 every allowed lookup passes, through inputlookup and lookup', allowPass.length === 0, allowPass.join(', '));

    /* ============================ C. the macros ============================ */
    const mc: string = fs.readFileSync(path.join(DEFAULT_DIR, 'macros.conf'), 'utf8').replace(/\r\n/g, '\n');
    const defs: Record<string, string> = {};
    mc.split(/^(?=\[)/m).forEach((chunk) => {
        const h = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (!h) return;
        let last: string | null = null;
        chunk.slice(h[0].length).split('\n').forEach((l) => {
            const d = /^definition\s*=\s?(.*)$/.exec(l);
            if (d) last = d[1].replace(/\s+$/, '');
        });
        if (last !== null) defs[h[1]] = last;
    });
    check('C1 APP_MACRO_DEFINITIONS = the last definition of each macros.conf stanza', Object.keys(defs).length > 0
        && JSON.stringify(Object.keys(lx.APP_MACRO_DEFINITIONS).sort().map((k) => [k, lx.APP_MACRO_DEFINITIONS[k]]))
        === JSON.stringify(Object.keys(defs).sort().map((k) => [k, defs[k]])), `${JSON.stringify(defs)} vs ${JSON.stringify(lx.APP_MACRO_DEFINITIONS)}`);
    check('C2 the macro names are ALLOWED_SPL_MACROS', JSON.stringify(Object.keys(lx.APP_MACRO_DEFINITIONS).sort())
        === JSON.stringify(Array.from(sg.ALLOWED_SPL_MACROS).sort()), '');
    check('C3 the data macro is sap_logserv_idx_macro and selects one index', lx.DATA_MACRO === 'sap_logserv_idx_macro'
        && /^index="?[a-z0-9_]+"?$/.test(lx.APP_MACRO_DEFINITIONS[lx.DATA_MACRO]), lx.APP_MACRO_DEFINITIONS[lx.DATA_MACRO]);

    /* ============================ D. the catalog ============================ */
    let catPass = 0;
    for (const p of catalog) {
        const r = sg.analyzeAdHocSpl(p.spl);
        check(`D1 the catalog search passes: ${p.savedSearch}`, r.blocked === false, JSON.stringify(r));
        if (!r.blocked) catPass += 1;
    }
    for (const q of nextSteps) {
        const r = sg.analyzeAdHocSpl(q);
        check(`D2 the nextStep SPL passes: ${q.slice(0, 70)}`, r.blocked === false, JSON.stringify(r));
    }
    check('D3 the whole catalog and every nextStep SPL were read', catalog.length >= 61 && catPass === catalog.length
        && nextSteps.length >= 17, `${catPass}/${catalog.length}, ${nextSteps.length} nextSteps`);
    const disagree: string[] = [];
    for (const q of catalog.map((p) => p.spl).concat(nextSteps).concat(PASS)) {
        const r = sg.analyzeAdHocSpl(q);
        if (r.blocked) continue;
        const rd: string[] = vc.readerCommandNames(q);
        // A command that is one App macro (the cloud-provider macro) is its
        // definition's command to the lexer and an unnamed command to the
        // reader, which makes every column after it untraced (fail closed).
        const lex = lx.lexSpl(q);
        const same = !!r.commands && r.commands.length === rd.length && lex.ok && r.commands.every((c: string, i: number) => c === rd[i]
            || (rd[i] === '' && lex.pipeline.commands[i].tokens[0] && lex.pipeline.commands[i].tokens[0].kind === 'macro'));
        if (!same) disagree.push(`${JSON.stringify(r.commands)} vs ${JSON.stringify(rd)}: ${q.slice(0, 80)}`);
    }
    check('D4 the lexer and the Tier 2 reader split every passing query into the same commands', disagree.length === 0,
        disagree.join(' / '));
    const ex = /'Example: ([^']*)' \+\s*'([^']*?)\.?',/.exec(hookSrc);
    const exQ = ex ? ex[1] + ex[2] : '';
    check('D5 the tool description\'s example passes and reads real fields (no action_status)', !!ex
        && sg.analyzeAdHocSpl(exQ).blocked === false && exQ.indexOf('action_status') === -1 && exQ.indexOf(M) === 0, exQ);
    const startMacro = sg.analyzeAdHocSpl(`${M} | stats count`);
    check('D6 a pass carries the command list and the data-macro start', JSON.stringify(startMacro.commands) === '["search","stats"]'
        && startMacro.startsWithDataMacro === true && sg.analyzeAdHocSpl('| makeresults').startsWithDataMacro === false
        && JSON.stringify(sg.analyzeAdHocSpl(`${M} | \`sap_logserv_cloud_provider_default_macro\` | bucket _time`).commands)
        === '["search","eval","bucket"]', JSON.stringify(startMacro));

    /* ============================ E. the rules ============================ */
    for (const q of PASS) {
        const r = sg.analyzeAdHocSpl(q);
        check(`E1 passes: ${q.slice(0, 90)}`, r.blocked === false, JSON.stringify(r));
    }
    const reasons: string[] = [];
    for (const [q, op, cmd] of REFUSE) {
        const r = sg.analyzeAdHocSpl(q);
        check(`E2 refuses with ${op}: ${q.slice(0, 80)}`, r.blocked === true && r.operator === op
            && (cmd === undefined || r.command === cmd), JSON.stringify(r));
        if (r.blocked && typeof r.reason === 'string') reasons.push(r.reason);
    }
    const opsSeen = new Set(REFUSE.map((x) => x[1]));
    const localOps = sg.ALLOW_LIST_OPERATORS.filter((o: string) => !/^parser_/.test(o));
    const opsUnprobed = localOps.filter((o: string) => !opsSeen.has(o));
    check('E3 every allow-list operator has a probe', opsUnprobed.length === 0, opsUnprobed.join(', '));
    // The denylist stays the first fence: every query it refuses is refused with its operator.
    const denyProbes = ['| makeresults | outputlookup x', '| delete', `${M} | sendemail to=x`, `${M} | script x`,
        '| from savedsearch:x', `${M} | "delete"`, `${M} | stats count by x | ai prompt=y`];
    for (const q of denyProbes) {
        const d = sg.analyzeSpl(q);
        const a = sg.analyzeAdHocSpl(q);
        check(`E4 the denylist refuses first, with its operator: ${q}`, d.blocked === true && a.blocked === true
            && a.operator === d.operator, `${JSON.stringify(d)} / ${JSON.stringify(a)}`);
    }
    // union (P2): the refusal names it and tells the model to combine the searches with append; any other command
    // off the list keeps the general reason.
    for (const q of P2_UNION_SHAPES) {
        const r = sg.analyzeAdHocSpl(q);
        check(`E5 a union is refused by name with the append hint: ${q.slice(0, 70)}`, r.blocked === true
            && r.operator === 'command_not_allowed' && r.command === 'union'
            && typeof instead.union === 'string'
            && r.reason === `The command "union" is not on the assistant's allow-list for ad-hoc queries, so the query was not run. ${instead.union}`,
        JSON.stringify(r));
    }
    const other = sg.analyzeAdHocSpl(`${M} | mvexpand x`);
    check('E5 another command off the list keeps the general reason', other.reason === 'The command "mvexpand" is not on the '
        + "assistant's allow-list for ad-hoc queries, so the query was not run. Use only the commands the system primer lists.",
    JSON.stringify(other));
    const proto = sg.analyzeAdHocSpl(`${M} | constructor x | tostring y`);
    check('E5 a command named like an Object property gets the general reason', proto.command === 'constructor'
        && /Use only the commands the system primer lists\.$/.test(String(proto.reason)), JSON.stringify(proto));

    /* ============================ F. the reasons ============================ */
    reasons.push(sg.parserUnavailable().reason, sg.parserRejected().reason);
    const pm = sg.checkParserAgreement(sg.analyzeAdHocSpl(`${M} | stats count`), { commands: [{ command: 'search' }, { command: 'fit' }] });
    if (pm.reason) reasons.push(pm.reason);
    for (const reason of reasons) {
        check(`F1 the reason reaches the vendor unchanged and under the cap: ${reason.slice(0, 50)}`,
            ve.vendorRefusalText(reason) === ve.REFUSAL_PREFIX + reason && reason.length <= ve.REFUSAL_MAX_CHARS, reason);
    }
    const badNames = REFUSE.map(([q]) => sg.analyzeAdHocSpl(q).command).filter((c: unknown) => c !== undefined
        && !(typeof c === 'string' && (/^[A-Za-z0-9_.:-]{1,64}$/.test(c) || c === '(unnamed)')));
    check('F2 a refusal\'s command is a safe name', badNames.length === 0, JSON.stringify(badNames));
    const longName = `${M} | ${'x'.repeat(65)} a`;
    check('F3 a name longer than 64 characters is recorded as (unnamed)', sg.analyzeAdHocSpl(longName).command === '(unnamed)'
        && sg.safeName('a b') === '(unnamed)' && sg.safeName('ok_name.1') === 'ok_name.1', JSON.stringify(sg.analyzeAdHocSpl(longName)));

    /* ============================ G. the lexer ============================ */
    const tk = lx.tokenizeSpl('a "b|c" \'d e\' `m` | [x] (y)');
    check('G1 tokens: a double-quoted string and a single-quoted name are one token each', tk.ok
        && JSON.stringify(tk.tokens.map((t: any) => t.kind)) === '["term","dquote","squote","macro","pipe","open","term","close","lparen","term","rparen"]',
    JSON.stringify(tk));
    check('G2 problems', lx.lexSpl('a "b').problem === 'unterminated_quote' && lx.lexSpl('a `b').problem === 'unpaired_backtick'
        && lx.lexSpl("a 'b").problem === 'ambiguous_single_quote' && lx.lexSpl("a 'b|c'").problem === 'ambiguous_single_quote'
        && lx.lexSpl('a ]').problem === 'unbalanced_bracket' && lx.lexSpl('a [b').problem === 'unbalanced_bracket'
        && lx.lexSpl(`a ${'['.repeat(lx.MAX_LEX_DEPTH + 1)}${']'.repeat(lx.MAX_LEX_DEPTH + 1)}`).problem === 'too_deep', '');
    // Security review of build 377: a backslash outside double quotes, and a macro glued to other text.
    check('G2 a backslash outside double quotes and a glued macro are problems; inside double quotes and next to a bracket they are not',
        lx.lexSpl('a \\| b').problem === 'escaped_outside_quotes' && lx.lexSpl('a\\[b]').problem === 'escaped_outside_quotes'
        && lx.lexSpl('\\a').problem === 'escaped_outside_quotes' && lx.lexSpl("a 'b\\c'").problem === 'ambiguous_single_quote'
        && lx.lexSpl('`m`x').problem === 'macro_adjacent' && lx.lexSpl('x`m`').problem === 'macro_adjacent'
        && lx.lexSpl('`m`(a)').problem === 'macro_adjacent' && lx.lexSpl('"a"`m`').problem === 'macro_adjacent'
        && lx.lexSpl('`a``b`').problem === 'macro_adjacent'
        && lx.lexSpl('a "b\\|c" | d').ok === true && lx.lexSpl('[`m`] | `m` |`m`|').ok === true
        && lx.lexSpl('\t`m`\n').ok === true, '');
    const hostile = `a ${'['.repeat(200000)}`;
    let threw = '';
    let deep: any = null;
    try {
        deep = lx.lexSpl(hostile);
    } catch (e) {
        threw = String(e);
    }
    check('G3 a hostile nesting does not exhaust the stack', threw === '' && deep && deep.ok === false && deep.problem === 'too_deep', threw);
    // The lexer reads any command name - union too, which the allow-list then refuses by name (E2, E5).
    const tree = lx.lexSpl(`| union [search ${M} | stats count] [| inputlookup t] | stats sum(count)`);
    check('G4 the tree: a leading pipe, groups on their command, depth', tree.ok && tree.pipeline.leadingPipe === true
        && JSON.stringify(lx.commandSequence(tree.pipeline)) === '["union","stats"]'
        && tree.pipeline.commands[0].groups.length === 2 && tree.pipeline.commands[0].groups[0].depth === 1
        && JSON.stringify(lx.commandSequence(tree.pipeline.commands[0].groups[1])) === '["inputlookup"]', JSON.stringify(tree).slice(0, 200));
    const ap = lx.lexSpl(`${M} | appendpipe [stats count]`);
    check('G5 an appendpipe group starts with a command; a pipeline without a leading pipe starts with search',
        ap.ok && lx.commandName(ap.pipeline.commands[1].groups[0], 0, true) === 'stats'
        && lx.commandName(ap.pipeline.commands[1].groups[0], 0, false) === 'search', '');

    /* ============================ H. the parser agreement ============================ */
    const local = sg.analyzeAdHocSpl(`${M} sourcetype=x | stats count by host`);
    const reply = (cmds: Array<[string, string?]>): any => ({ commands: cmds.map(([c, r]) => (r === undefined ? { command: c } : { command: c, rawargs: r })) });
    const agree = sg.checkParserAgreement(local, reply([['search', 'index="sap_logserv_logs" sourcetype=x'], ['stats', 'count by host']]));
    check('H1 the same reading passes', agree.blocked === false, JSON.stringify(agree));
    const cases: Array<[string, any, string]> = [
        ['a nested command not on the list', { commands: [{ command: 'search', args: { sub: { command: 'outputlookup' } } }, { command: 'stats' }] }, 'parser_mismatch'],
        ['another top-level list', reply([['search'], ['stats'], ['collect']]), 'parser_mismatch'],
        ['a shorter list', reply([['search']]), 'parser_mismatch'],
        ['another first command', reply([['tstats'], ['stats']]), 'parser_mismatch'],
        ['the macro expands to something else', reply([['search', 'index=* sourcetype=x'], ['stats']]), 'parser_mismatch'],
        ['the macro expands with an OR after it', reply([['search', 'index="sap_logserv_logs" OR index=main'], ['stats']]), 'parser_mismatch'],
        ['the macro expands to no index (every default index)', reply([['search', 'sourcetype=x'], ['stats']]), 'parser_mismatch'],
        ['the macro expands with an OR and no other index', reply([['search', 'index=sap_logserv_logs OR sourcetype=x'], ['stats']]), 'parser_mismatch'],
        ['an index term in a later command', reply([['search', 'index=sap_logserv_logs'], ['stats', 'count by host index=main']]), 'parser_mismatch'],
        // security review of build 377: text glued to the LogServ index value is another index
        ['a glued suffix on the index value in a later command', reply([['search', 'index=sap_logserv_logs'], ['stats', 'count by host index="sap_logserv_logs"_archive']]), 'parser_mismatch'],
        ['no command list', { commands: [] }, 'parser_unavailable'],
        ['not an object', 'nope', 'parser_unavailable'],
        ['a command without a name', { commands: [{ rawargs: 'x' }] }, 'parser_unavailable'],
    ];
    for (const [what, body, op] of cases) {
        const r = sg.checkParserAgreement(local, body);
        check(`H2 ${what}: ${op}`, r.blocked === true && r.operator === op, JSON.stringify(r));
    }
    const alias = sg.checkParserAgreement(sg.analyzeAdHocSpl(`${M} | bucket _time span=1h | stats count by _time`),
        reply([['search'], ['bin'], ['stats']]));
    check('H3 bucket and bin are one command; unexpanded or absent raw arguments are not judged', alias.blocked === false
        && sg.checkParserAgreement(local, reply([['search', `${M} sourcetype=x`], ['stats']])).blocked === false, JSON.stringify(alias));
    const refusedLocal = sg.analyzeAdHocSpl(`${M} | fit X y`);
    check('H4 a local refusal stays the refusal', sg.checkParserAgreement(refusedLocal, reply([['search']])) === refusedLocal, '');
    const big: any[] = [];
    for (let i = 0; i < sg.PARSER_REPLY_MAX_NODES; i += 1) big.push({ x: i });
    check('H5 a reply too large to walk is unavailable', sg.checkParserAgreement(local, { commands: [{ command: 'search' }, { command: 'stats' }], pad: big })
        .operator === 'parser_unavailable', '');
    check('H6 foreignIndexTerm', !sg.foreignIndexTerm('index="sap_logserv_logs" x') && !sg.foreignIndexTerm('index::sap_logserv_logs')
        && !sg.foreignIndexTerm('count by index') && sg.foreignIndexTerm('index=main') && sg.foreignIndexTerm('index!=sap_logserv_logs')
        && sg.foreignIndexTerm('index IN (sap_logserv_logs)') && sg.foreignIndexTerm('"index"="x"') && sg.foreignIndexTerm('a="index=x"'), '');
    check('H6 foreignIndexTerm: the value ends where a term ends (security review of build 377)',
        sg.foreignIndexTerm('index="sap_logserv_logs"*') && sg.foreignIndexTerm('index="sap_logserv_logs"_archive x')
        && sg.foreignIndexTerm('index=sap_logserv_logs"x"') && sg.foreignIndexTerm('index="sap_logserv_logs"(x)')
        && !sg.foreignIndexTerm('[search index="sap_logserv_logs"]') && !sg.foreignIndexTerm('(index="sap_logserv_logs") x')
        && !sg.foreignIndexTerm('index="sap_logserv_logs"|') && !sg.foreignIndexTerm('index=sap_logserv_logs\tx'), '');
    check('H7 dataMacroAsShipped', sg.dataMacroAsShipped('index="sap_logserv_logs" sourcetype=x')
        && sg.dataMacroAsShipped('search index=sap_logserv_logs') && !sg.dataMacroAsShipped('index=sap_logserv_logs_x')
        && !sg.dataMacroAsShipped('index=sap_logserv_logs OR x') && !sg.dataMacroAsShipped('index=main'), '');
    // The request (splParserCheck.ts).
    const req = pc.buildParserRequest(`${M} | stats count`, 'jane.doe@example.com', 'tok123');
    const body = new URLSearchParams(req.init.body);
    check('H8 the parser request: POST search/parser in the user\'s namespace of this App, parse_only, macros expanded, JSON, CSRF',
        req.url === '/en-US/splunkd/__raw/servicesNS/jane.doe%40example.com/splunk_app_sap_logserv/search/parser'
        && req.init.method === 'POST' && req.init.credentials === 'same-origin' && req.init.headers['X-Splunk-Form-Key'] === 'tok123'
        && body.get('q') === `search ${M} | stats count` && body.get('parse_only') === '1' && body.get('expand_macros') === '1'
        && body.get('output_mode') === 'json', `${req.url} ${req.init.body}`);
    check('H9 the parser text: a leading pipe or search kept, anything else the implicit search; an empty user is nobody',
        pc.parserQueryText(' | makeresults ') === '| makeresults' && pc.parserQueryText('search x') === 'search x'
        && pc.parserQueryText(`${M} x`) === `search ${M} x` && pc.buildParserRequest('| makeresults', '', '').url.indexOf('/servicesNS/nobody/') !== -1, '');
    const okBody = JSON.stringify(reply([['search', 'index="sap_logserv_logs" sourcetype=x'], ['stats', 'count by host']]));
    check('H10 the reply: 200 JSON compared, 400 rejected, any other status or a non-JSON body unavailable',
        pc.interpretParserReply(local, 200, okBody).blocked === false
        && pc.interpretParserReply(local, 400, '{"messages":[]}').operator === 'parser_rejected'
        && [401, 403, 404, 500, 502, 0, 302].every((st) => pc.interpretParserReply(local, st, okBody).operator === 'parser_unavailable')
        && pc.interpretParserReply(local, 200, '<html>').operator === 'parser_unavailable'
        && pc.interpretParserReply(refusedLocal, 200, okBody) === refusedLocal, '');
    // vetAdHocQuery: the whole check, fail closed.
    const q = `${M} sourcetype=x | stats count by host`;
    let calls = 0;
    const fetchOk = async (): Promise<{ status: number; text: () => Promise<string> }> => {
        calls += 1;
        return { status: 200, text: async () => okBody };
    };
    const v1 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', fetchImpl: fetchOk });
    check('H11 a query both readings agree on passes, after one parser call', v1.blocked === false && calls === 1, JSON.stringify(v1));
    calls = 0;
    const v2 = await pc.vetAdHocQuery(`${M} | fit X y`, { user: 'u', csrf: 'c', fetchImpl: fetchOk });
    check('H12 a local refusal makes no parser call', v2.blocked === true && v2.operator === 'command_not_allowed' && calls === 0, JSON.stringify(v2));
    calls = 0;
    const vUnion = await Promise.all(P2_UNION_SHAPES.map((uq) => pc.vetAdHocQuery(uq, { user: 'u', csrf: 'c', fetchImpl: fetchOk })));
    check('H12 a union is refused before the parser is asked (no call), by name', calls === 0
        && vUnion.every((x: any) => x.blocked === true && x.operator === 'command_not_allowed' && x.command === 'union'), JSON.stringify(vUnion));
    const v3 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', fetchImpl: async () => { throw new Error('network down'); } });
    check('H13 a failed call refuses (parser_unavailable), no error text passed on', v3.blocked === true && v3.operator === 'parser_unavailable'
        && String(v3.reason).indexOf('network down') === -1, JSON.stringify(v3));
    const t0 = Date.now();
    const v4 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', timeoutMs: 50, fetchImpl: () => new Promise(() => undefined) });
    check('H14 a call that never answers is refused at the timeout', v4.operator === 'parser_unavailable' && Date.now() - t0 < 5000, JSON.stringify(v4));
    const ac = new AbortController();
    ac.abort();
    calls = 0;
    const v5 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', signal: ac.signal, fetchImpl: fetchOk });
    check('H15 an aborted turn refuses without a call', v5.operator === 'parser_unavailable' && calls === 0, JSON.stringify(v5));
    const v6 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify(reply([['search'], ['stats'], ['outputlookup']])) }) });
    check('H16 a parser that reads another command refuses (parser_mismatch)', v6.operator === 'parser_mismatch' && v6.command === 'outputlookup', JSON.stringify(v6));
    const v7 = await pc.vetAdHocQuery(q, { user: 'u', csrf: 'c', fetchImpl: async () => ({ status: 400, text: async () => '{"messages":[{"text":"Unknown search command"}]}' }) });
    check('H17 a parser rejection refuses with the App\'s own text', v7.operator === 'parser_rejected' && String(v7.reason).indexOf('Unknown') === -1, JSON.stringify(v7));
    check('H18 the parser timeout is a positive bound under a minute', pc.PARSER_TIMEOUT_MS > 0 && pc.PARSER_TIMEOUT_MS <= 60000, String(pc.PARSER_TIMEOUT_MS));
    // The hook calls the full check, with the user and the turn's signal, and records the command.
    const hookCode = hookSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('H19 the hook vets ad-hoc queries through vetAdHocQuery and records the command', (hookCode.match(/\bvetAdHocQuery\(/g) || []).length === 1
        && hookCode.indexOf('const guard = await vetAdHocQuery(adHocQuery, { user: ctx.user, signal: controller.signal });') !== -1
        && hookCode.indexOf("if (toolName === 'splunk_run_query') {\n                                const adHocQuery = typeof mcpArgs.query === 'string' ? mcpArgs.query : '';\n") !== -1
        && hookCode.indexOf('...(guard.command ? { command: guard.command } : {}),') !== -1
        && !/\banalyzeSpl\b|\banalyzeAdHocSpl\b/.test(hookCode), '');
    // A turn the user stops while the parser runs is not a refusal: the blocked-SPL audit event is skipped
    // for it, and only for it (parser_unavailable with the turn's own signal aborted).
    check('H20 a query stopped by the user during the parser check records no security_blocked_spl event',
        hookCode.indexOf('const stoppedByUser = guard.operator === OPERATOR_PARSER_UNAVAILABLE && controller.signal.aborted;') !== -1
        && hookCode.indexOf('if (!stoppedByUser) ctx.actions.recordAudit(blockedAudit);') !== -1
        && (hookCode.match(/recordAudit\(blockedAudit\)/g) || []).length === 1
        && hookCode.indexOf("import { OPERATOR_PARSER_UNAVAILABLE } from '../utils/splGuard';") !== -1
        && sg.OPERATOR_PARSER_UNAVAILABLE === 'parser_unavailable' && sg.parserUnavailable().operator === sg.OPERATOR_PARSER_UNAVAILABLE, '');

    /* ============================ I. the lookup names in the parser's reply (build 378) ============================ */
    // The raw arguments live probe P2 (session 155) recorded for top-level lookups, verbatim from its replies.
    const P2_LOOKUP_RAW: Array<[string, string, string]> = [
        ['inputlookup', 'logserv_wp_perf_rollup where metric="wperr" ', 'logserv_wp_perf_rollup'],
        ['inputlookup', 'logserv_stmap_rollup ', 'logserv_stmap_rollup'],
        ['inputlookup', 'logserv_topology_edges ', 'logserv_topology_edges'],
        ['inputlookup', 'logserv_severity_rollup where metric="toterr" ', 'logserv_severity_rollup'],
        ['lookup', 'logserv_ti_malicious_domains domain AS q OUTPUT category AS ti_category, source AS ti_source, notes AS ti_notes ',
            'logserv_ti_malicious_domains'],
        ['lookup', 'logserv_ti_malicious_ips ip AS dest OUTPUT category AS ti_category, source AS ti_source, notes AS ti_notes ',
            'logserv_ti_malicious_ips'],
        ['lookup', 'logserv_ti_compromised_credentials username AS auth_user OUTPUT added_date, notes AS ti_notes ',
            'logserv_ti_compromised_credentials'],
    ];
    const p2Wrong = P2_LOOKUP_RAW.filter(([c, raw, wantName]) => sg.parserLookupName(c, raw) !== wantName);
    check('I1 the raw-argument shapes P2 recorded read to their lookup', p2Wrong.length === 0, JSON.stringify(p2Wrong));
    check('I1 the documented options, exactly', JSON.stringify(sg.PARSER_LOOKUP_OPTIONS)
        === '{"inputlookup":["append","strict","start","max"],"lookup":["local","update","event_time_field"]}'
        && Object.isFrozen(sg.PARSER_LOOKUP_OPTIONS) && Object.isFrozen(sg.PARSER_LOOKUP_OPTIONS.lookup)
        && Object.isFrozen(sg.PARSER_LOOKUP_OPTIONS.inputlookup), JSON.stringify(sg.PARSER_LOOKUP_OPTIONS));
    // P2 showed it: a top-level command's raw arguments are its text after the command name up to the next
    // top-level pipe, leading whitespace dropped (and macros expanded). Build them that way for every query the
    // allow-list passes and give them to the agreement check with the lexer's own command list.
    const topPipes = (q: string): number[] => {
        const tz = lx.tokenizeSpl(q);
        const out: number[] = [];
        let depth = 0;
        if (!tz.ok) return out;
        tz.tokens.forEach((x: any) => {
            if (x.kind === 'open') depth += 1;
            else if (x.kind === 'close') depth -= 1;
            else if (x.kind === 'pipe' && depth === 0) out.push(x.start);
        });
        return out;
    };
    let lookupCmds = 0;
    const synthBad: string[] = [];
    for (const q of catalog.map((p) => p.spl).concat(nextSteps).concat(PASS)) {
        const r = sg.analyzeAdHocSpl(q);
        const l = lx.lexSpl(q);
        if (r.blocked || !l.ok) continue;
        const pipes = topPipes(q);
        const names: string[] = r.commands || [];
        const cmds = l.pipeline.commands.map((cmd: any, i: number) => {
            const name = names[i];
            if (name !== 'lookup' && name !== 'inputlookup') return { command: name };
            lookupCmds += 1;
            const end = cmd.tokens[0].end;
            const next = pipes.find((s) => s > end);
            const raw = q.slice(end, next === undefined ? q.length : next).replace(/^\s+/, '');
            if (sg.parserLookupName(name, raw) !== cmd.tokens.filter((x: any, k: number) => k > 0 && !/=/.test(x.text))[0].text) {
                synthBad.push(`reads another name: ${raw}`);
            }
            return { command: name, rawargs: raw };
        });
        const v = sg.checkParserAgreement(r, { commands: cmds });
        if (v.blocked) synthBad.push(`${v.operator} ${v.command}: ${q.slice(0, 80)}`);
    }
    check('I2 every catalog, nextStep and pass-corpus query with a top-level lookup agrees and reads the lexer\'s lookup',
        lookupCmds >= 30 && synthBad.length === 0, `${lookupCmds} lookup commands; ${synthBad.join(' / ')}`);
    const lkLocal = sg.analyzeAdHocSpl(`${M} | lookup logserv_ti_malicious_ips ip AS dest OUTPUT category`);
    const ilLocal = sg.analyzeAdHocSpl('| inputlookup logserv_mc_rollup | stats count');
    const lkReply = (raw: unknown): any => sg.checkParserAgreement(lkLocal, { commands: [
        { command: 'search', rawargs: 'index="sap_logserv_logs" ' },
        raw === undefined ? { command: 'lookup' } : { command: 'lookup', rawargs: raw }] });
    const ilReply = (raw: unknown): any => sg.checkParserAgreement(ilLocal, { commands: [
        raw === undefined ? { command: 'inputlookup' } : { command: 'inputlookup', rawargs: raw },
        { command: 'stats', rawargs: 'count' }] });
    const NOT_ONE = 'names a lookup that is not one of this App\'s';
    const UNREAD = 'cannot be read';
    const refusedAs = (r: any, cmd: string, why: string): boolean => !!r && r.blocked === true
        && r.operator === 'parser_mismatch' && r.command === cmd && typeof r.reason === 'string' && r.reason.indexOf(why) !== -1;
    const lkNotAllowed: unknown[] = [
        'logserv_diag_reports report_id OUTPUT x',
        'splunk_for_sap_logserv_identities identity OUTPUT email',
        'customer_hr_lookup user OUTPUT ssn',
        'dnslookup clientip',
        'logserv_ti_malicious_ips.csv ip',
        'logserv_mc_rollup2 host',
        '\n\tlogserv_diag_platform_snapshot x',
        'local=t update=f logserv_diag_reports report_id',
    ];
    const lkUnreadable: unknown[] = [
        // the security review's shape (a quoted option value before the name; P2 info row, not probed live)
        "event_time_field='x logserv_diag_reports report_id ' logserv_mc_rollup host",
        'event_time_field="x" logserv_ti_malicious_ips ip',
        'logserv_ti_malicious_ips"_x" ip',
        '"logserv_ti_malicious_ips" ip',
        'x=1 logserv_ti_malicious_ips ip',
        'LOCAL=t logserv_ti_malicious_ips ip',
        'max=5 logserv_ti_malicious_ips ip',
        'logserv_ti_malicious_ips(ip)',
        'logserv_ti_malicious_ips[x]',
        'local=t',
        '',
        '   ',
        undefined,
        42,
    ];
    const ilNotAllowed: unknown[] = ['logserv_diag_reports ', 'logserv_ai_models ', 'x.csv',
        'append=t max=10 logserv_diag_reports where report_id=1'];
    const ilUnreadable: unknown[] = ['logserv_mc_rollup"_x"', 'max="5" logserv_mc_rollup', 'local=t logserv_mc_rollup',
        'logserv_mc_rollup]', "'logserv_mc_rollup'", undefined];
    const wrongI3 = lkNotAllowed.filter((x) => !refusedAs(lkReply(x), 'lookup', NOT_ONE))
        .concat(lkUnreadable.filter((x) => !refusedAs(lkReply(x), 'lookup', UNREAD)))
        .concat(ilNotAllowed.filter((x) => !refusedAs(ilReply(x), 'inputlookup', NOT_ONE)))
        .concat(ilUnreadable.filter((x) => !refusedAs(ilReply(x), 'inputlookup', UNREAD)));
    check('I3 a lookup that is not the App\'s, or a shape that cannot be read, is refused (parser_mismatch, naming the command)',
        lkLocal.blocked === false && ilLocal.blocked === false && wrongI3.length === 0, JSON.stringify(wrongI3));
    const okI4 = [
        lkReply('logserv_ti_malicious_ips ip AS dest OUTPUT category'),
        lkReply('local=t update=f event_time_field=_time logserv_ti_malicious_ips ip AS dest OUTPUT category'),
        ilReply('append=t strict=f start=0 max=10 logserv_mc_rollup where metric="x"'),
        ilReply('  logserv_mc_rollup'),
        ilReply('logserv_mc_rollup'),
        ilReply('logserv_mc_rollup\twhere metric="x"'),
    ];
    check('I4 the App\'s lookups pass, with the documented options, any whitespace and at the end of the text',
        okI4.every((r) => r.blocked === false) && sg.parserLookupName('stats', 'logserv_mc_rollup') === null
        && sg.parserLookupName('constructor', 'logserv_mc_rollup') === null
        && sg.parserLookupName('__proto__', 'logserv_mc_rollup') === null
        && sg.parserLookupName('inputlookup', 'append=t max=10 logserv_topology_edges where type="rfc"') === 'logserv_topology_edges',
    JSON.stringify(okI4));
    // The scope: P2 showed a lookup inside a subsearch is no command of its own in the reply (its text is part of
    // the raw arguments of the command that holds the subsearch) - the lexer's reading is its only check. The
    // same is true of every command in a subsearch: P2's replies held no nested command node at all.
    const joinQ = `${M} | join type=left host [| inputlookup logserv_hostdetails_rollup | stats sum(count) as vol by host]`;
    const joinReply = { commands: [{ command: 'search', rawargs: 'index="sap_logserv_logs" ' },
        { command: 'join', rawargs: 'type=left host [| inputlookup logserv_hostdetails_rollup | stats sum(count) as vol by host]' }] };
    const joinRead = sg.readParserReply(joinReply);
    check('I5 a lookup in a subsearch: no command node of its own in the reply (P2), the lexer refuses one that is not the App\'s',
        !!joinRead && joinRead.all.indexOf('inputlookup') === -1 && sg.checkParserAgreement(sg.analyzeAdHocSpl(joinQ), joinReply).blocked === false
        && sg.analyzeAdHocSpl(`${M} | join type=left host [| inputlookup logserv_diag_reports | stats count by host]`).operator
            === 'lookup_not_allowed', JSON.stringify(joinRead));
    const iReasons = [lkReply('logserv_diag_reports x'), lkReply(undefined), ilReply('logserv_ai_models'), ilReply('"x"')]
        .map((r: any) => String(r.reason));
    check('I6 the two refusals reach the vendor unchanged and under the cap, and quote only the command',
        iReasons.every((reason) => ve.vendorRefusalText(reason) === ve.REFUSAL_PREFIX + reason && reason.length <= ve.REFUSAL_MAX_CHARS
            && reason.indexOf('logserv_') === -1), JSON.stringify(iReasons));
    // I7 (review of build 378): EVERY top-level lookup / inputlookup is read again, not only the first or the
    // last one - a query with three (and one with two), the name that is not the App's (or cannot be read) in
    // each position in turn; each must refuse, naming the command at that position.
    const ML_CMDS = ['inputlookup', 'lookup', 'lookup'];
    const ML_RAW = ['logserv_mc_rollup ', 'logserv_ti_malicious_ips ip AS host OUTPUT category ',
        'logserv_ti_malicious_domains domain AS host OUTPUT category AS c2'];
    const mlLocal = sg.analyzeAdHocSpl('| inputlookup logserv_mc_rollup | lookup logserv_ti_malicious_ips ip AS host OUTPUT category'
        + ' | lookup logserv_ti_malicious_domains domain AS host OUTPUT category AS c2');
    const mlReply = (bad: number, raw: string): any => sg.checkParserAgreement(mlLocal, {
        commands: ML_CMDS.map((c, i) => ({ command: c, rawargs: i === bad ? raw : ML_RAW[i] })) });
    const lk2Local = sg.analyzeAdHocSpl('| inputlookup logserv_mc_rollup | lookup logserv_ti_malicious_ips ip AS host OUTPUT category');
    const lk2Reply = (first: string, second: string): any => sg.checkParserAgreement(lk2Local, { commands: [
        { command: 'inputlookup', rawargs: first }, { command: 'lookup', rawargs: second }] });
    const wrongI7: string[] = [];
    if (mlLocal.blocked !== false || lk2Local.blocked !== false) wrongI7.push('the local check refuses a probe');
    if (mlReply(-1, '').blocked !== false) wrongI7.push('three of the App\'s lookups refused');
    if (lk2Reply(ML_RAW[0], ML_RAW[1]).blocked !== false) wrongI7.push('two of the App\'s lookups refused');
    ML_CMDS.forEach((c, i) => {
        if (!refusedAs(mlReply(i, 'logserv_diag_reports x '), c, NOT_ONE)) wrongI7.push(`not the App's, at command ${i + 1}`);
        if (!refusedAs(mlReply(i, '"logserv_mc_rollup" '), c, UNREAD)) wrongI7.push(`cannot be read, at command ${i + 1}`);
    });
    if (!refusedAs(lk2Reply('logserv_mc_rollup ', 'logserv_diag_reports ip AS host OUTPUT category'), 'lookup', NOT_ONE)) {
        wrongI7.push('the second of two');
    }
    if (!refusedAs(lk2Reply('logserv_diag_reports ', 'logserv_ti_malicious_ips ip AS host OUTPUT category'), 'inputlookup', NOT_ONE)) {
        wrongI7.push('the first of two');
    }
    check('I7 every top-level lookup / inputlookup is read again, not only the first or the last', wrongI7.length === 0,
        JSON.stringify(wrongI7));

    if (failures === 0) {
        console.log(`splGuard consistency test: ${checks} checks OK (${allowed.length} commands and ${allowedLookups.length} lookups`
            + ` allowed; ${catalog.length} catalog searches and ${nextSteps.length} nextStep SPL pass; ${REFUSE.length} refusal probes;`
            + ' the search-parser check fails closed)');
    } else {
        process.stderr.write(`splGuard consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};

export {};
