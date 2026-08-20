/**
 * Build-time consistency test for `splProbe.ts` (session 093).
 *
 * The probe classifies the SPL a panel ACTUALLY dispatched, so its only real
 * risk is misreading a shape that ships. Every case below is a VERBATIM
 * dispatched string (or the exact historical defect text) taken from the
 * session-093 census of all 21 data dashboards — not an invented example.
 *
 * Two kinds of assertion:
 *   1. CLASSIFICATION — tier / collection / metric / grain / sourcetypes /
 *      filters, over the real corpus shapes including every documented trap.
 *   2. LINT — each rule must fire on the REAL historical defect text and stay
 *      silent on the REAL shipped-correct text that looks similar. A lint that
 *      cries wolf on shipped code is worse than no lint (design doc, Risk 8).
 *
 * Run with: `npx ts-node --transpile-only splProbe.consistency-test.ts`
 * Exits 1 on failure so it can gate a build.
 */

/* eslint-disable no-console */

// Standalone script using `require` — the trailing `export {}` marks it a
// MODULE so its top-level consts don't collide with the sibling
// *.consistency-test.ts files in the project-wide `tsc` pass (TS2451).

const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./splProbe') as any;
const probeSpl = mod.probeSpl as (s: string) => {
    tier: string;
    collection?: string;
    collections: string[];
    metric?: string;
    grain: string;
    hasRangeFilter: boolean;
    sourcetypes: string[];
    tags: string[];
    lookups: string[];
    macros: string[];
    cloudFilter?: { form: string; provider: string };
    hostFilter?: { form: string; hosts: string[]; topN?: number };
    grainFilters: string[];
    fieldFilters: Array<{
        field: string;
        op: string;
        values: string[];
        origin: string;
        fragment: string;
        wildcard: boolean;
    }>;
    baseDisjunction: boolean;
    headLimit?: number;
    hasSubsearch: boolean;
    emptySafeKpi: boolean;
    lint: Array<{ code: string; fragment: string; explanation: string }>;
    notes: string[];
};

let failures = 0;
let checks = 0;

const fail = (msg: string): void => {
    failures += 1;
    proc.stderr.write(`FAIL: ${msg}\n`);
};

const eq = (label: string, got: unknown, want: unknown): void => {
    checks += 1;
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fail(`${label}: got ${g}, want ${w}`);
};

// ---------------------------------------------------------------------------
// 1. Classification over the real corpus
// ---------------------------------------------------------------------------

// --- a plain hourly rollup read (the single most common shape: ~340 of ~600)
{
    const spl =
        '| inputlookup logserv_wp_perf_rollup where metric="abap" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count';
    const p = probeSpl(spl);
    eq('rollup.tier', p.tier, 'cached');
    eq('rollup.collection', p.collection, 'logserv_wp_perf_rollup');
    eq('rollup.metric', p.metric, 'abap');
    eq('rollup.grain', p.grain, 'hourly');
    eq('rollup.hasRangeFilter', p.hasRangeFilter, true);
    eq('rollup.sourcetypes', p.sourcetypes, []);
    eq('rollup.notes', p.notes, []);
}

// --- TRAP 1: `where metric=` is OPTIONAL (stmap / beaconing / slowtrace)
{
    const p = probeSpl(
        '| inputlookup logserv_stmap_rollup | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count by sourcetype, source, host | fields - count',
    );
    eq('noMetric.tier', p.tier, 'cached');
    eq('noMetric.collection', p.collection, 'logserv_stmap_rollup');
    eq('noMetric.metric', p.metric, undefined);
}

// --- TRAP 2: the day_ts grain (the two beaconing collections)
{
    const p = probeSpl(
        '| inputlookup logserv_beaconing_rollup | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count',
    );
    eq('daily.tier', p.tier, 'cached');
    eq('daily.grain', p.grain, 'daily');
    eq('daily.emptySafeKpi', p.emptySafeKpi, true);
}

// --- TRAP 3: `| search sourcetype="x"` AFTER an inputlookup is a KV GRAIN
//     filter, not an index predicate. It must NOT populate `sourcetypes`.
{
    const p = probeSpl(
        '| inputlookup logserv_severity_rollup where metric="toterr" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search sourcetype="sap:hana:audit" | stats sum(count) as count',
    );
    eq('grainFilter.tier', p.tier, 'cached');
    eq('grainFilter.sourcetypes', p.sourcetypes, []);
    eq('grainFilter.grainFilters', p.grainFilters, ['sourcetype="sap:hana:audit"']);
}

// --- tstats: predicate lives between WHERE and BY
{
    const p = probeSpl(
        '| tstats count, dc(host) AS hosts, max(_time) AS last_seen WHERE `sap_logserv_idx_macro` sourcetype="sap:scc:http_access" BY sourcetype | sort - count',
    );
    eq('tstats.tier', p.tier, 'tstats');
    eq('tstats.sourcetypes', p.sourcetypes, ['sap:scc:http_access']);
    eq('tstats.macros', p.macros, ['sap_logserv_idx_macro']);
    // `BY sourcetype` is a group-by and must NOT be read as a constraint.
    eq('tstats.grain', p.grain, 'none');
}

// --- raw, quoted + unquoted + IN + parenthesised OR (all four ship)
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_peer_ip=* | stats count as Requests',
    );
    eq('raw.tier', p.tier, 'raw');
    eq('raw.sourcetypes', p.sourcetypes, ['sap:abap:icm']);
}
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype=sap:hana:audit | head 500 | table _time');
    eq('rawUnquoted.sourcetypes', p.sourcetypes, ['sap:hana:audit']);
    eq('rawUnquoted.headLimit', p.headLimit, 500);
}
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype IN ("sap:sapstartsrv", "sap:saphostexec") | stats count',
    );
    eq('rawIn.sourcetypes', p.sourcetypes, ['sap:sapstartsrv', 'sap:saphostexec']);
}
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` (sourcetype="sap:webdispatcher:access" OR sourcetype="sap:scc:http_access") | stats count',
    );
    eq('rawOr.sourcetypes', p.sourcetypes, ['sap:webdispatcher:access', 'sap:scc:http_access']);
}

// --- DnsAnalytics scopes by tag, never by sourcetype
{
    const p = probeSpl('`sap_logserv_idx_macro` tag=dns message_type="Query" | stats count');
    eq('tagScope.sourcetypes', p.sourcetypes, []);
    eq('tagScope.tags', p.tags, ['dns']);
}

// --- a NEGATIVE sourcetype constraint is not a requirement
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype!="syslog" | stats count');
    eq('negSourcetype.sourcetypes', p.sourcetypes, []);
}

// --- cloud-provider splices, both forms emitted by withCloudProvider
{
    const p = probeSpl(
        '| inputlookup logserv_dns_rollup where metric="main" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="azure" | stats sum(count) as count',
    );
    eq('cloudRollup', p.cloudFilter, { form: 'rollup', provider: 'azure' });
}
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` (cloud_provider="aws" OR NOT cloud_provider=*) sourcetype="squid:access" | stats count',
    );
    eq('cloudRawAws', p.cloudFilter, { form: 'raw', provider: 'aws' });
    eq('cloudRawAws.sourcetypes', p.sourcetypes, ['squid:access']);
}
{
    const p = probeSpl('| tstats count WHERE `sap_logserv_idx_macro` cloud_provider="gcp" sourcetype="sap:scc:audit"');
    eq('cloudRawGcp', p.cloudFilter, { form: 'raw', provider: 'gcp' });
}

// --- host filter, all three shipped dialects
{
    const p = probeSpl('`sap_logserv_idx_macro` host="hec53v013858" | stats count');
    eq('hostEq', p.hostFilter, { form: 'eq', hosts: ['hec53v013858'] });
}
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` host IN ("hec53v013858","hec53v026858") | timechart span=1d count',
    );
    eq('hostIn', p.hostFilter, { form: 'in', hosts: ['hec53v013858', 'hec53v026858'] });
}
{
    const p = probeSpl(
        '| tstats count WHERE `sap_logserv_idx_macro` (host="hec53v013858" OR host="hec53v026858") BY sourcetype',
    );
    eq('hostOr', p.hostFilter, { form: 'or', hosts: ['hec53v013858', 'hec53v026858'] });
}
// TRAP 4: the Top-N host subsearch — the macro appears TWICE and the subsearch
// contents must not leak into the outer predicate scope.
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` [search `sap_logserv_idx_macro` | top limit=10 host | fields host]  | timechart span=1d count as daily | stats avg(daily) AS perday',
    );
    eq('hostTopN.form', p.hostFilter && p.hostFilter.form, 'topn');
    eq('hostTopN.n', p.hostFilter && p.hostFilter.topN, 10);
    eq('hostTopN.hasSubsearch', p.hasSubsearch, true);
    eq('hostTopN.tier', p.tier, 'raw');
}
// rollup dialect: host arrives as `| search (host=… OR host=…)` after the range
{
    const p = probeSpl(
        '| inputlookup logserv_hostdetails_rollup where metric="vol" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search cloud_provider="aws" | search (host="a" OR host="b") | stats sum(count) as count',
    );
    eq('hostRollup.form', p.hostFilter && p.hostFilter.form, 'or');
    eq('hostRollup.cloud', p.cloudFilter && p.cloudFilter.provider, 'aws');
    eq('hostRollup.grainFilters', p.grainFilters, []);
}

// --- TRAP: two inputlookups in one query (AbapSecurity gwHosts join)
{
    const p = probeSpl(
        '| inputlookup logserv_abapnet_rollup where metric="gwhost" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as Events by gw_remote_host, gw_function | join type=left gw_remote_host gw_function [ | inputlookup logserv_abapnet_rollup where metric="gwlatest" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats latest(gw_error_detail) as "Last Error" by gw_remote_host, gw_function ] | sort -Events',
    );
    eq('join.tier', p.tier, 'cached');
    eq('join.metric', p.metric, 'gwhost');
    eq('join.collections', p.collections, ['logserv_abapnet_rollup']);
}

// --- TRAP 6: regex literals containing pipes and brackets must not split
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="linux_secure" | rex field=_raw "(?<fw_action>IN_DROP|IN_ACCEPT)" | where fw_action="IN_DROP" | stats count',
    );
    eq('regexPipe.tier', p.tier, 'raw');
    eq('regexPipe.sourcetypes', p.sourcetypes, ['linux_secure']);
    eq('regexPipe.lint', p.lint, []);
}
{
    // stmap raw arm — rex mode=sed with brace quantifiers and <id>/<date> tokens
    const p = probeSpl(
        '`sap_logserv_idx_macro` | eval source_n=source | rex mode=sed field=source_n "s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<id>/g" | rex mode=sed field=source_n "s/[0-9]{4}-[0-9]{2}-[0-9]{2}/<date>/g" | stats count by sourcetype, source_n, host',
    );
    eq('sedRegex.tier', p.tier, 'raw');
    eq('sedRegex.lint', p.lint, []);
}
{
    // escaped quotes inside a regex (HanaTrace slowestOps)
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="sap:hana:tracelogs" | rex field=_raw "^\\"(?<hana_op>[^\\"]+)\\"" | stats count by hana_op',
    );
    eq('escapedQuotes.tier', p.tier, 'raw');
    eq('escapedQuotes.sourcetypes', p.sourcetypes, ['sap:hana:tracelogs']);
}

// --- TRAP 6 (discriminating): a quoted ALTERNATION regex contains a `|`. A
//     quote-blind splitter truncates the segment it lives in, which silently
//     changes the answer. These two cases fail if quote tracking is dropped —
//     the earlier regex cases above do not, because the damage lands in a
//     segment nothing asserts on (found by mutation-testing this file).
{
    // (i) a pipe inside a quoted value in the BASE clause: a naive split loses
    //     every predicate after it, including the sourcetype.
    const p = probeSpl(
        '`sap_logserv_idx_macro` hana_op="read|write" sourcetype="sap:hana:audit" | stats count',
    );
    eq('quotedPipeInBase.sourcetypes', p.sourcetypes, ['sap:hana:audit']);
}
{
    // (ii) a pipe inside a quoted regex EARLIER in a `| where` clause: a naive
    //      split makes the second half look like a new command, so the
    //      bare-boolean rule stops seeing it as a `where` and goes silent.
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="sap:saprouter" | where match(action, "^(CONNECT|DISCONNECT|INVAL)") AND is_business_hours=false | stats count',
    );
    checks += 1;
    if (!p.lint.some((l) => l.code === 'bare-boolean-in-where')) {
        fail('quotedPipeInWhere: expected the bare-boolean rule to still fire after a quoted pipe');
    }
}

// --- TRAP 8: MultiCloudOverview chains a SECOND macro
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` | `sap_logserv_cloud_provider_default_macro` | where cloud_provider="aws" | stats count',
    );
    eq('twoMacros.tier', p.tier, 'raw');
    eq('twoMacros.macros', p.macros, [
        'sap_logserv_idx_macro',
        'sap_logserv_cloud_provider_default_macro',
    ]);
}

// --- a CSV / non-rollup lookup read as a generating command is a LOOKUP
//     dependency, not a KV collection. (No dashboard does this today; the
//     distinction exists so an added `| inputlookup foo.csv` panel is
//     classified as a lookup dependency rather than a phantom rollup.)
{
    const p = probeSpl(
        '| inputlookup splunk_for_sap_logserv_assets.csv | stats count by category',
    );
    eq('csvLookup.collections', p.collections, []);
    eq('csvLookup.collection', p.collection, undefined);
    eq('csvLookup.lookups', p.lookups, ['splunk_for_sap_logserv_assets.csv']);
}

// --- the empty-safe scalar-KPI idiom is present on most KPI reads and ABSENT
//     on some (AbapOperations uses a plain `| stats sum(count) as count`).
//     The distinction matters: without it a rollup-backed KPI over an EMPTY
//     collection returns zero ROWS, so the card renders an em-dash rather than
//     a zero — a strong "this rollup was never backfilled" signal.
{
    const withIdiom = probeSpl(
        '| inputlookup logserv_linux_rollup where metric="total" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count',
    );
    eq('emptySafe.present', withIdiom.emptySafeKpi, true);
    const without = probeSpl(
        '| inputlookup logserv_wp_perf_rollup where metric="abap" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count',
    );
    eq('emptySafe.absent', without.emptySafeKpi, false);
}

// --- a rollup read with NO range filter must be flagged (it ignores the picker)
{
    const p = probeSpl('| inputlookup logserv_topology_inventory | stats count');
    eq('noRange.tier', p.tier, 'cached');
    eq('noRange.hasRangeFilter', p.hasRangeFilter, false);
    eq('noRange.grain', p.grain, 'none');
    eq('noRange.noteCount', p.notes.length, 1);
}

// --- unknown shape degrades, never guesses
{
    const p = probeSpl('| makeresults count=1 | eval x=1');
    eq('unknown.tier', p.tier, 'unknown');
    eq('unknown.noteCount', p.notes.length, 1);
}
{
    const p = probeSpl('');
    eq('empty.tier', p.tier, 'unknown');
}

// ---------------------------------------------------------------------------
// 1b. Field filters (checks 22 & 25) — §17.3 / §17.8a-8,10
// ---------------------------------------------------------------------------

// A simple conjunction: sourcetype excluded, the real field captured (eq).
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" is_critical=true | head 500 | table x',
    );
    eq('ff.simple.count', p.fieldFilters.length, 1);
    eq('ff.simple.field', p.fieldFilters[0]?.field, 'is_critical');
    eq('ff.simple.op', p.fieldFilters[0]?.op, 'eq');
    eq('ff.simple.values', p.fieldFilters[0]?.values, ['true']);
    eq('ff.simple.disjunction', p.baseDisjunction, false);
}
// A quoted value.
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype="sap:scc:audit" scc_audit_type="ACCESS_DENIED" | stats count');
    eq('ff.quoted.field', p.fieldFilters[0]?.field, 'scc_audit_type');
    eq('ff.quoted.values', p.fieldFilters[0]?.values, ['ACCESS_DENIED']);
}
// Negation → existence-only (neq, no values).
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype="sap:hana:audit" status!="SUCCESSFUL" | stats count');
    eq('ff.neq.op', p.fieldFilters[0]?.op, 'neq');
    eq('ff.neq.values', p.fieldFilters[0]?.values, []);
}
// IN list.
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype="x" severity IN ("critical","error","high") | stats count');
    const f = p.fieldFilters.find((x) => x.field === 'severity');
    eq('ff.in.op', f?.op, 'in');
    eq('ff.in.values', f?.values, ['critical', 'error', 'high']);
}
// A single top-level disjunction → NO field filters, flagged (§17.8a-8).
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` ((sourcetype="a" x="1") OR (sourcetype="b" y="2")) | stats count',
    );
    eq('ff.disjunction.flag', p.baseDisjunction, true);
    eq('ff.disjunction.count', p.fieldFilters.length, 0);
}
// Computed name (assigned by eval before a where) is excluded (§17.8a-10).
{
    const p = probeSpl(
        '`sap_logserv_idx_macro` sourcetype="x" | eval is_err=if(status>=400,1,0) | where is_err=1 | stats count',
    );
    eq('ff.computed.excluded', p.fieldFilters.some((f) => f.field === 'is_err'), false);
}
// Controlled fields (host) never become field filters.
{
    const p = probeSpl('`sap_logserv_idx_macro` sourcetype="x" host="h1" f="v" | stats count');
    eq('ff.host.excluded', p.fieldFilters.some((f) => f.field === 'host'), false);
    eq('ff.host.otherKept', p.fieldFilters.some((f) => f.field === 'f'), true);
}
// Cached-tier reads carry NO field filters (raw-only).
{
    const p = probeSpl(
        '| inputlookup logserv_wp_perf_rollup where metric="abap" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | search sap_sid="XCP" | stats count',
    );
    eq('ff.cached.none', p.fieldFilters.length, 0);
}

// ---------------------------------------------------------------------------
// 2. Lint — positive controls (REAL historical defect text)
// ---------------------------------------------------------------------------

const hasCode = (
    p: { lint: Array<{ code: string }> },
    code: string,
): boolean => p.lint.some((l) => l.code === code);

const expectLint = (label: string, spl: string, code: string): void => {
    checks += 1;
    if (!hasCode(probeSpl(spl), code)) fail(`${label}: expected lint "${code}" to fire`);
};
const expectClean = (label: string, spl: string): void => {
    checks += 1;
    const p = probeSpl(spl);
    if (p.lint.length > 0) {
        fail(`${label}: expected NO lint, got ${JSON.stringify(p.lint.map((l) => l.code))}`);
    }
};

// (a) match() in a base clause — the live defect in the shipped ES correlation
//     search `splunk_sap_logserv_es_hana_privilege_escalation` (savedsearches
//     .conf:395). The GRANT ... WITH ADMIN OPTION disjunct never fires.
expectLint(
    'lint.matchInBase.esPrivEsc',
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" tag=change ((action_type=GRANT AND match(sql_statement, "(?i)WITH ADMIN OPTION")) OR (action_type="ALTER USER" AND target_user="SYSTEM")) | stats count by executing_user',
    'match-in-base',
);
// the same defect inside a `| union [search ...]` arm — the shape every rollup
// aggregate uses, so the rule must see through one bracket level
expectLint(
    'lint.matchInBase.inUnionArm',
    '| union [search `sap_logserv_idx_macro` sourcetype="linux:sudolog" match(_raw, "(?i)passwd\\b") | stats count]',
    'match-in-base',
);
// ...and after a `| search` command, which also has base-search semantics
expectLint(
    'lint.matchInBase.searchCommand',
    '| inputlookup logserv_compliance_rollup where metric="main" | search match(operator, "(?i)adm")',
    'match-in-base',
);
// NEGATIVE: match() after `| where` is the CORRECT shipped form (the session-051
// fix in ChangeConfig) and must stay silent.
expectClean(
    'lint.matchInBase.afterWhere',
    '`sap_logserv_idx_macro` (sourcetype="linux:sudolog") | where match(_raw, "(?i)passwd\\b") | stats count',
);
// NEGATIVE: match() inside an `| eval case(...)` classification.
expectClean(
    'lint.matchInBase.inEval',
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | eval Category=case(match(action_type,"(?i)user"), "User Management", 1=1, "Other") | stats count by Category',
);
// NEGATIVE: an identifier that merely ends in "match".
expectClean(
    'lint.matchInBase.cidrmatch',
    '`sap_logserv_idx_macro` sourcetype="linux_secure" | where cidrmatch("10.0.0.0/8", src_ip) | stats count',
);

// (b) bare boolean in a `where` — the session-091 defect that made every
//     "after hours" filter in the product a no-op.
expectLint(
    'lint.bareBool.whereFalse',
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" is_admin_user=true | where is_business_hours=false | stats count',
    'bare-boolean-in-where',
);
// NEGATIVE: the SAME text in a BASE clause is a literal term match and WORKS —
// this asymmetry is exactly why the defect survived review for so long.
expectClean(
    'lint.bareBool.baseIsCorrect',
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" is_critical=true | head 500 | table _time',
);
// NEGATIVE: a QUOTED boolean in a where is correct.
expectClean(
    'lint.bareBool.quoted',
    '`sap_logserv_idx_macro` sourcetype="sap:abap:icm" | where icm_is_error="true" | stats count',
);
// NEGATIVE: command options are the largest FP surface in the corpus
// (`useother=false`, `usenull=f`, `append=true`, `summariesonly=false`).
expectClean(
    'lint.bareBool.commandOptions',
    '| tstats summariesonly=false count WHERE `sap_logserv_idx_macro` BY sourcetype, _time span=1h | timechart span=1h sum(count) by sourcetype limit=0 useother=false',
);
// NEGATIVE (discriminating): the pattern appearing INSIDE a quoted string is
// not a comparison at all. Fails if the rule stops masking string literals
// before matching (found by mutation-testing this file).
expectClean(
    'lint.bareBool.insideQuotedString',
    '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | where match(sql_statement, "(?i)audit_enabled=true") | stats count',
);

// (c) string-boolean compared to a number — the live defect at
//     EnvironmentHealth.tsx:230 (Total Errors KPI drilldown), the sole survivor
//     of the build-227 sweep.
expectLint(
    'lint.numVsStr.icmIsError',
    '`sap_logserv_idx_macro` ((sourcetype="sap:abap:icm" icm_is_error=1) OR (sourcetype="sap:hana:audit" status!="SUCCESSFUL")) | stats count',
    'numeric-vs-string-boolean',
);
expectLint(
    'lint.numVsStr.isError',
    '`sap_logserv_idx_macro` sourcetype="sap:scc:http_access" | eval is_err=if(is_error=1,1,0) | stats sum(is_err)',
    'numeric-vs-string-boolean',
);
// NEGATIVE: the correct quoted form.
expectClean(
    'lint.numVsStr.correctQuoted',
    '`sap_logserv_idx_macro` (sourcetype="sap:abap:icm" icm_is_error="true") | stats count',
);
// NEGATIVE — THE ONE THAT ACTUALLY BITES: HanaAudit's afterHoursAdmin panel
// redefines `is_weekend` numerically in-query, so `is_weekend=1` is CORRECT.
// Without the shadowing guard this fires twice on a perfectly good panel.
expectClean(
    'lint.numVsStr.inQueryShadowed',
    '`sap_logserv_idx_macro` sourcetype=sap:hana:audit is_admin_user=true | eval is_weekend=if(strftime(_time,"%w") IN ("0","6"), 1, 0) | eval is_after_hours=if(tonumber(strftime(_time,"%H")) < 8 OR tonumber(strftime(_time,"%H")) > 18, 1, 0) | where is_after_hours=1 OR is_weekend=1 | head 500 | table _time',
);
// NEGATIVE: a numeric comparison on a genuinely numeric field.
expectClean(
    'lint.numVsStr.realNumeric',
    '`sap_logserv_idx_macro` sourcetype="sap:webdispatcher:access" status>=400 | stats count',
);

// The 16-name table must match props.conf exactly (drift guard).
{
    const want = [
        'icm_is_error',
        'is_admin_user',
        'is_auth_event',
        'is_authenticated',
        'is_business_hours',
        'is_connection_event',
        'is_critical',
        'is_error',
        'is_internal_ip',
        'is_localhost',
        'is_service_account',
        'is_ssl_event',
        'is_successful',
        'is_system_user',
        'is_upgrade_check',
        'is_weekend',
    ];
    eq('EVAL_STRING_BOOLEAN_FIELDS', Array.from(mod.EVAL_STRING_BOOLEAN_FIELDS).sort(), want);
}

// ---------------------------------------------------------------------------
// §18.8a-27 residual — column-origin resolution + the scalar-twin field
// preconditions (session 104). These are the parse shapes the review named as
// the error-prone ones: a rename AFTER the table command (21 of 69 shipped
// tables), quoted spaced display names, whole-pipeline computed names, and the
// remove-form `| fields -` that must NOT read as a terminal singleton.
// ---------------------------------------------------------------------------
{
    const origins = mod.resolveColumnOrigins as (
        spl: string,
        cols: ReadonlyArray<string>,
    ) => Record<string, { kind: string; probeName?: string }>;

    // (a) rename AFTER `| table` — the display name must chase back to its
    // source field, never be probed as itself.
    {
        const spl =
            '`sap_logserv_idx_macro` sourcetype="sap:webdispatcher:access" | table _time, uri, status | rename uri as "Request URI"';
        const o = origins(spl, ['Request URI', 'status']);
        eq('origins.renameAfterTable', o['Request URI'], { kind: 'renamed', probeName: 'uri' });
        eq('origins.passthroughSibling', o['status'], { kind: 'passthrough', probeName: 'status' });
    }

    // (b) quoted spaced display name — "Max RSS (MB)" was the review's named
    // false-floor generator (the safe-identifier gate would silently drop it if
    // the rename source were not resolved first).
    {
        const spl =
            '| inputlookup logserv_linux_rollup where metric="oom" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats max(max_rss) as max_rss by host | rename max_rss as "Max RSS (MB)"';
        const o = origins(spl, ['Max RSS (MB)', 'host']);
        // max_rss is ALSO a stats `as` output → computed wins over renamed: the
        // name cannot exist on raw events, so probing it would be dishonest.
        eq('origins.quotedSpacedName', o['Max RSS (MB)'], { kind: 'computed' });
        eq('origins.groupByPassthrough', o['host'], { kind: 'passthrough', probeName: 'host' });
    }

    // (b2) quoted spaced rename of a PLAIN passthrough field — the probeable case.
    {
        const spl =
            '`sap_logserv_idx_macro` sourcetype="linux_messages_syslog" | table host, oom_proc | rename oom_proc as "OOM Victim (process)"';
        const o = origins(spl, ['OOM Victim (process)']);
        eq('origins.quotedRenamePlain', o['OOM Victim (process)'], { kind: 'renamed', probeName: 'oom_proc' });
    }

    // (c) eval-assigned + rex-captured + lookup-OUTPUT + eventstats — computed
    // everywhere in the pipeline (§17.8a-10 extended whole-pipeline).
    {
        const spl =
            '`sap_logserv_idx_macro` sourcetype="sap:abap:icm" | rex field=_raw "(?<gw_peer>\\S+)" | lookup squid_actions_210 status OUTPUT action | eventstats sum(count) as total | eval rate=round(err/total*100,1) | table gw_peer, action, total, rate, host';
        const o = origins(spl, ['gw_peer', 'action', 'total', 'rate', 'host']);
        eq('origins.rexCapture', o['gw_peer'], { kind: 'computed' });
        eq('origins.lookupOutput', o['action'], { kind: 'computed' });
        eq('origins.eventstatsAs', o['total'], { kind: 'computed' });
        eq('origins.evalAssigned', o['rate'], { kind: 'computed' });
        eq('origins.plainPassthrough', o['host'], { kind: 'passthrough', probeName: 'host' });
    }

    // (d) transitive rename chain resolves to the FIRST source; a chain that
    // lands on a computed name stays computed.
    {
        const spl = '| stats count by peer | rename peer as peer_ip | rename peer_ip as "Peer address"';
        const o = origins(spl, ['Peer address']);
        eq('origins.transitiveChain', o['Peer address'], { kind: 'renamed', probeName: 'peer' });
    }
    {
        const spl = '| eval x=1 | rename x as "Display X"';
        const o = origins(spl, ['Display X']);
        eq('origins.chainToComputed', o['Display X'], { kind: 'computed' });
    }

    // (e) stats `as` output is computed; the by-field is passthrough (the
    // Linux OOM panel's exact shape).
    {
        const spl =
            '`sap_logserv_idx_macro` sourcetype="linux_messages_syslog" "Out of memory" | stats count as Kills by host';
        const o = origins(spl, ['Kills', 'host']);
        eq('origins.statsAs', o['Kills'], { kind: 'computed' });
        eq('origins.statsBy', o['host'], { kind: 'passthrough', probeName: 'host' });
    }

    // (f) total: every input column gets an entry, even unknown ones.
    {
        const o = origins('', ['anything']);
        eq('origins.totalOnEmptySpl', o['anything'], { kind: 'passthrough', probeName: 'anything' });
    }
}

{
    const term = mod.terminalSingletonField as (spl: string) => string | null;
    const twinField = mod.scalarTwinFieldFor as (a: string, b: string) => string | null;

    const CACHED_KPI =
        '| inputlookup logserv_abapnet_rollup where metric="icmerr" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats count as n, sum(count) as count | fillnull value=0 count | fields count';
    const RAW_KPI =
        '`sap_logserv_idx_macro` sourcetype="sap:abap:icm" icm_is_error="true" | stats count as n, count as count | fillnull value=0 count | fields count';

    eq('twin.keepFormSingleton', term(CACHED_KPI), 'count');
    eq('twin.tableSingleton', term('| stats sum(x) as count | table count'), 'count');
    eq('twin.quotedSingleton', term('| stats sum(x) as count | fields "count"'), 'count');
    // The remove-form is NOT a singleton — `| fields - n` keeps everything else.
    eq('twin.removeFormIsNull', term('| stats count as n, sum(count) as count | fields - n'), null);
    // Multi-field keep-lists and pipelines with no terminal fields are null.
    eq('twin.multiFieldIsNull', term('| stats sum(x) as count | fields count, host'), null);
    eq('twin.noTerminalFieldsIsNull', term('| stats count by host'), null);
    // The review's blocker P-4 shape: kpiBandwidth's multi-field row must never
    // yield a probe field.
    eq(
        'twin.kpiBandwidthShapeIsNull',
        term('| stats count as n, sum(bytes_sum) as total_bytes, sum(count) as total | fillnull value=0 total_bytes'),
        null,
    );

    // The shared-field precondition: both arms must agree on the SAME name.
    eq('twin.sharedField', twinField(CACHED_KPI, RAW_KPI), 'count');
    eq(
        'twin.mismatchedArmsIsNull',
        twinField(CACHED_KPI, '`sap_logserv_idx_macro` | stats count as total | fields total'),
        null,
    );
    eq('twin.oneArmNotSingletonIsNull', twinField(CACHED_KPI, '| stats count by host'), null);
}

// ---------------------------------------------------------------------------

if (failures > 0) {
    proc.stderr.write(`\nsplProbe consistency test: ${failures} failure(s) of ${checks} checks\n`);
    proc.exit(1);
}
console.log(`splProbe consistency test: ${checks} checks OK`);

export {};
