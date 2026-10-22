/**
 * diagIngestFacts consistency test (session 099 / build 314, design §15 +
 * §15.8a). Async, fake-FetchLike-driven — exports `run(): Promise<number>`
 * and is awaited by bin/check-diagnostics.js (the diagPersistence shape).
 *
 * WHAT IS PINNED HERE
 *  - The parser against the LIVE captured shapes (grounding §1.4–1.7): REST
 *    JSON (incl. two-entry lists + the bare content object), REST XML,
 *    generated transforms.conf (full / empty-markers / props-line /
 *    wrong-file / start-without-end / both marker blocks), settings-conf,
 *    CRLF variants, cloud-provider-only pastes.
 *  - The GENERATOR-mirroring evaluator semantics (review blocker B2):
 *    slashless patterns are inert on BOTH lists; pass-all rules; per-segment
 *    case-SENSITIVE matching; multi-slash split; the XmlWinEventLog partial
 *    rule; the TAG_CLZ_MAP.
 *  - The self-validating cutoff recovery (§15.8a-16): live regexes,
 *    tampered/foreign/implausible rejection, the generator port round-trip.
 *  - The scrubber: secret-substring-ABSENT for every §15.8a-21 form.
 *  - Storage encoding + sanitize-on-read domain clamps (§15.8a-24/25) and
 *    the parsed-paste-stores-no-raw rule (§15.8a-22).
 *  - The KV client: fixed-key create-or-overwrite, the 409 first-paste race
 *    retry (§15.8a-26), read-side excerpt truncation (§15.8a-23).
 *  - Constants literal-pinned (the STALE_LAG convention).
 *  - Session 154: the current generated shape (design s154 §5a goldens,
 *    chunks, source stanzas, cut-off pastes, headers of any shape), the two
 *    settings keys, the KV row fields, the page's save path
 *    (`prepareIngestPaste`: raw structure, scrubbed storage) and check 29's
 *    source-rule handling.
 *  - Session 154 round 2: the linear '*' translation (design s154 §5b
 *    goldens, copied from the design by testing/fnfilter_s154/scratch/
 *    r2_app/design_goldens.py), multi-star folder / source / combined
 *    entries read back COLLAPSED, the §5a text still read as before, hostile
 *    atomic-group residue, and recovered pattern = generated REGEX on values
 *    (atomic groups emulated as lookahead + backreference).
 *
 * Regex-bearing fixtures use String.raw and the file is byte-verified after
 * every edit (the tool-transport hazard bit this exact feature area in
 * session 095).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const process: { stderr: { write(s: string): void } };

const proc = process;
const mod = require('./diagIngestFacts') as any;

const NOW = 1786310000;

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, okC: boolean, detail?: string): void => {
        checks += 1;
        if (!okC) {
            failures += 1;
            proc.stderr.write(`FAIL: diagIngestFacts ${label}: ${detail || ''}\n`);
        }
    };

    // --- constants literal-pinned -------------------------------------------
    check('const.pasteCap', mod.MAX_INGEST_PASTE_CHARS === 200000);
    check('const.stale', mod.INGEST_FACTS_STALE_SECONDS === 7 * 86400);
    check('const.margin', mod.INGEST_CUTOFF_MIN_MARGIN_SECONDS === 86400);
    check('const.excerpt', mod.INGEST_RAW_EXCERPT_CHARS === 2000);
    check('const.maxDays', mod.INGEST_MAX_DAYS_IN_PAST === 3650);
    check('const.collection', mod.DIAG_INGEST_FACTS_COLLECTION === 'logserv_diag_ingest_facts');
    check('const.key', mod.INGEST_FACTS_KEY === 'latest');
    // §19.8a-9 — 16 -> 17 with cloud_provider_stamp (L6's pin update);
    // session 154 — 17 -> 19 with the two source-rule lists.
    check('const.fields', Array.isArray(mod.DIAG_INGEST_FACT_FIELDS) && mod.DIAG_INGEST_FACT_FIELDS.length === 19);
    check('const.fieldsStamp', mod.DIAG_INGEST_FACT_FIELDS.indexOf('cloud_provider_stamp') !== -1);
    check('const.fieldsIncSources', mod.DIAG_INGEST_FACT_FIELDS.indexOf('include_sources_json') !== -1);
    check('const.fieldsExcSources', mod.DIAG_INGEST_FACT_FIELDS.indexOf('exclude_sources_json') !== -1);
    check('const.maxSourcePatterns', mod.INGEST_MAX_SOURCE_PATTERNS === 256);
    check('const.maxSourceEntryChars', mod.INGEST_MAX_SOURCE_ENTRY_CHARS === 4096);
    check('const.maxSourcePatternChars', mod.INGEST_MAX_SOURCE_PATTERN_CHARS === 512);
    check('const.maxListJson', mod.INGEST_MAX_LIST_JSON_CHARS === 300000);
    // §19.8a-12 — the index-time skew grace, literal-pinned.
    check('const.recentSkew', mod.INGEST_RECENT_SKEW_SECONDS === 300);

    // --- fixture builder -----------------------------------------------------
    const facts = (over: Record<string, unknown> = {}): any =>
        Object.assign(
            {
                suppliedAt: NOW - 100,
                suppliedBy: 'admin',
                sourceHost: '',
                inputShape: 'rest-json',
                parseStatus: 'parsed',
                parseNote: '',
                filterEnabled: true,
                daysInPast: 30,
                cutoffEpoch: null,
                includeFilters: [],
                excludeFilters: [],
                includeSources: [],
                excludeSources: [],
                filtersApproximate: false,
                cloudProviderStamp: null,
                scrubbedRaw: '',
            },
            over,
        );

    // --- cutoff recovery (live regexes; cutoffs 1785628800 / 1755129600) ----
    const RX1 = String.raw`"_time"\s*:\s*"?(?:0\d{9}|1[0-6]\d{8}|17[0-7]\d{7}|178[0-4]\d{6}|1785[0-5]\d{5}|17856[0-1]\d{4}|178562[0-7]\d{3}|1785628[0-7]\d{2})(?:\.\d+)?`;
    const RX2 = String.raw`"_time"\s*:\s*"?(?:0\d{9}|1[0-6]\d{8}|17[0-4]\d{7}|175[0-4]\d{6}|17550\d{5}|17551[0-1]\d{4}|175512[0-8]\d{3}|1755129[0-5]\d{2})(?:\.\d+)?`;
    check('cutoff.live1', mod.recoverCutoffFromRegex(RX1, NOW) === 1785628800, String(mod.recoverCutoffFromRegex(RX1, NOW)));
    check('cutoff.live2', mod.recoverCutoffFromRegex(RX2, NOW) === 1755129600, String(mod.recoverCutoffFromRegex(RX2, NOW)));
    check('cutoff.foreign', mod.recoverCutoffFromRegex('foo|bar', NOW) === null);
    // §15.8a-16: tampered alternation fails the round-trip
    const RXT = RX1.replace('178562[0-7]', '178562[0-8]');
    check('cutoff.tamperRejected', mod.recoverCutoffFromRegex(RXT, NOW) === null);
    // implausible for the given clock
    check('cutoff.implausible', mod.recoverCutoffFromRegex(RX1, 1500000000) === null);
    // generator port reproduces the live body exactly
    const body1 = RX1.slice(RX1.indexOf('(?:') + 3, RX1.indexOf(')(?:'));
    check('cutoff.generatorPort', mod.generateEpochLessThanRegex(1785628800) === body1, mod.generateEpochLessThanRegex(1785628800));
    // trailing-zero cutoff round-trips through the port + recovery
    const rz = mod.generateEpochLessThanRegex(1780000000);
    check('cutoff.trailingZeros', mod.recoverCutoffFromRegex('"_time"(?:' + rz + ')', NOW) === 1780000000, rz);

    // --- parser: REST JSON (live shape) --------------------------------------
    const LIVE_JSON = JSON.stringify({
        origin: 'https://localhost:8089/servicesNS/nobody/splunk_ta_sap_logserv/splunk_ta_sap_logserv_settings/filter_settings',
        entry: [
            {
                name: 'filter_settings',
                id: 'https://splunk-ds-01:8089/servicesNS/nobody/splunk_ta_sap_logserv/splunk_ta_sap_logserv_settings/filter_settings/filter_settings',
                content: {
                    days_in_past: '360',
                    disabled: false,
                    'eai:acl': null,
                    exclude_filters: '',
                    filter_enabled: '0',
                    include_filters: '*',
                },
            },
        ],
    });
    const pj = mod.parseIngestPaste(LIVE_JSON, NOW);
    check('json.shape', pj.inputShape === 'rest-json', pj.inputShape);
    check('json.disabled', pj.filterEnabled === false);
    check('json.parsed', pj.parseStatus === 'parsed', pj.parseStatus);
    check('json.starAsSupplied', pj.includeFilters.length === 1 && pj.includeFilters[0] === '*');
    check('json.days', pj.daysInPast === 360);
    check('json.noCutoffWhenDisabled', pj.cutoffEpoch === null);
    check('json.host', pj.sourceHost === 'splunk-ds-01', pj.sourceHost);
    const pe = mod.parseIngestPaste(LIVE_JSON.replace('"filter_enabled":"0"', '"filter_enabled":"1"'), NOW);
    check('json.enabledCutoff', pe.cutoffEpoch === mod.cutoffFromDays(360, NOW));
    // two-entry parent-endpoint paste picks filter_settings by NAME (§15.8a-19)
    const TWO = JSON.stringify({
        entry: [
            { name: 'cloud_provider_settings', content: { cloud_provider: 'aws' } },
            { name: 'filter_settings', content: { filter_enabled: '1', include_filters: '*/*', exclude_filters: 'proxy/squid', days_in_past: '30' } },
        ],
    });
    const p2 = mod.parseIngestPaste(TWO, NOW);
    check('json.twoEntryPicksFilter', p2.parseStatus === 'parsed' && p2.excludeFilters[0] === 'proxy/squid', p2.parseStatus);
    // cloud-provider-only paste never misreads as filter facts (§15.8a-19)
    const CLOUD_ONLY = JSON.stringify({ entry: [{ name: 'cloud_provider_settings', content: { cloud_provider: 'aws' } }] });
    check('json.cloudOnlyUnparsed', mod.parseIngestPaste(CLOUD_ONLY, NOW).parseStatus === 'unparsed');
    // bare content object
    const BARE = JSON.stringify({ filter_enabled: '1', include_filters: '*/*', exclude_filters: '', days_in_past: '7' });
    check('json.bareContent', mod.parseIngestPaste(BARE, NOW).parseStatus === 'parsed');

    // --- parser: REST XML -----------------------------------------------------
    const XML = [
        '<!--This is to override browser formatting-->',
        '<feed xmlns:s="http://dev.splunk.com/ns/rest"><entry >',
        '<title>filter_settings</title>',
        '<id>https://hf-99:8089/servicesNS/nobody/x/filter_settings</id>',
        '<content type="text/xml"><s:dict>',
        '<s:key name="days_in_past">30</s:key>',
        '<s:key name="exclude_filters">proxy/squid</s:key>',
        '<s:key name="filter_enabled">1</s:key>',
        '<s:key name="include_filters">*/*</s:key>',
        '</s:dict></content></entry></feed>',
    ].join('\n');
    const px = mod.parseIngestPaste(XML, NOW);
    check('xml.shape', px.inputShape === 'rest-xml');
    check('xml.enabled', px.filterEnabled === true);
    check('xml.exclude', px.excludeFilters.length === 1 && px.excludeFilters[0] === 'proxy/squid');
    check('xml.host', px.sourceHost === 'hf-99', px.sourceHost);
    check('xml.cutoff', px.cutoffEpoch === mod.cutoffFromDays(30, NOW));
    const XML_CLOUD = XML.replace(/<title>filter_settings<\/title>/, '<title>cloud_provider_settings</title>');
    check('xml.cloudOnlyUnparsed', mod.parseIngestPaste(XML_CLOUD, NOW).parseStatus === 'unparsed');

    // --- parser: generated transforms.conf ------------------------------------
    const TC = [
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###',
        '[logserv_filter_include_drop]',
        'REGEX = .',
        'FORMAT = nullQueue',
        'DEST_KEY = queue',
        '',
        '[logserv_filter_include_allow]',
        String.raw`REGEX = (?:^(?=.*"clz_dir"\s*:\s*"linux")(?=.*"clz_subdir"\s*:\s*".*"))|(?:^(?=.*"clz_dir"\s*:\s*"hana")(?=.*"clz_subdir"\s*:\s*"hanaaudit"))`,
        'FORMAT = indexQueue',
        'DEST_KEY = queue',
        '',
        '[logserv_filter_exclude]',
        String.raw`REGEX = ^(?=.*"clz_dir"\s*:\s*"linux")(?=.*"clz_subdir"\s*:\s*"cron")`,
        'FORMAT = nullQueue',
        'DEST_KEY = queue',
        '',
        '[logserv_filter_time_drop]',
        'REGEX = ' + RX1,
        'FORMAT = nullQueue',
        'DEST_KEY = queue',
        '',
        '### END LOGSERV FILTER CONFIG ###',
    ].join('\n');
    const pt = mod.parseIngestPaste(TC, NOW);
    check('tc.shape', pt.inputShape === 'transforms-conf');
    check('tc.enabled', pt.filterEnabled === true);
    check('tc.approx', pt.filtersApproximate === true);
    check('tc.cutoff', pt.cutoffEpoch === 1785628800, String(pt.cutoffEpoch));
    check('tc.includes', JSON.stringify(pt.includeFilters) === JSON.stringify(['linux/*', 'hana/hanaaudit']), JSON.stringify(pt.includeFilters));
    check('tc.excludes', JSON.stringify(pt.excludeFilters) === JSON.stringify(['linux/cron']));
    check('tc.parsedWhenClean', pt.parseStatus === 'parsed', pt.parseStatus);
    // §15.8a-15: complete empty marker pair = POSITIVE disabled signature
    const pte = mod.parseIngestPaste('### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###\n\n### END LOGSERV FILTER CONFIG ###', NOW);
    check('tc.emptyPairDisabled', pte.filterEnabled === false && pte.parseStatus === 'parsed');
    // START without END: partial, never a disabled conclusion
    const ptc = mod.parseIngestPaste('### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###\n# cut off here', NOW);
    check('tc.startNoEnd', ptc.parseStatus === 'partial' && ptc.filterEnabled === null, ptc.parseStatus);
    // props.conf paste: proves ACTIVE, carries nothing else
    const ptp = mod.parseIngestPaste('[sap_logserv_logs]\nTRANSFORMS-00-filter = logserv_filter_include_drop, logserv_filter_include_allow', NOW);
    check('tc.propsPartial', ptp.filterEnabled === true && ptp.parseStatus === 'partial');
    // §15.8a-15: the shipped DEFAULT transforms.conf is recognized + hinted
    const wf = mod.parseIngestPaste('# @logserv_filter: hana/hanaaudit\n[set_srctype_hana_audit]\nREGEX = x', NOW);
    check('tc.wrongFile', wf.parseStatus === 'unparsed' && wf.parseNote.indexOf('default/transforms.conf') !== -1, wf.parseNote);
    // both marker blocks in one paste: extraction stays FILTER-scoped
    const BOTH = TC + '\n\n### BEGIN LOGSERV CLOUD_PROVIDER CONFIG - DO NOT EDIT MANUALLY ###\n[logserv_set_cloud_provider]\nREGEX = .\nFORMAT = cloud_provider::aws\nWRITE_META = true\n\n### END LOGSERV CLOUD_PROVIDER CONFIG ###';
    const pb = mod.parseIngestPaste(BOTH, NOW);
    check('tc.bothBlocks', pb.filterEnabled === true && pb.cutoffEpoch === 1785628800 && pb.excludeFilters[0] === 'linux/cron');
    // unrecoverable regex residue degrades to partial (§15.8a-17)
    const TCBAD = TC.replace(String.raw`"clz_subdir"\s*:\s*"cron"`, String.raw`"clz_subdir"\s*:\s*"cr(o|u)n"`);
    const pbad = mod.parseIngestPaste(TCBAD, NOW);
    check('tc.residuePartial', pbad.parseStatus === 'partial', pbad.parseStatus);

    // --- parser: settings-conf + CRLF ------------------------------------------
    const SC = '[filter_settings]\nfilter_enabled = 1\ninclude_filters = */*\nexclude_filters = linux/cron\ndays_in_past = 7\n\n[cloud_provider_settings]\ncloud_provider = not_set';
    const ps = mod.parseIngestPaste(SC, NOW);
    check('sc.shape', ps.inputShape === 'settings-conf');
    check('sc.parsed', ps.parseStatus === 'parsed' && ps.filterEnabled === true && ps.daysInPast === 7);
    check('sc.exclude', ps.excludeFilters[0] === 'linux/cron');
    const crlf = mod.parseIngestPaste(SC.split('\n').join('\r\n'), NOW);
    check('sc.crlf', crlf.parseStatus === 'parsed' && crlf.daysInPast === 7, crlf.parseStatus);
    check('parser.empty', mod.parseIngestPaste('   ', NOW).parseStatus === 'unparsed');

    // --- scrubber (§15.8a-21: secret-substring-ABSENT per form) ----------------
    const CRED =
        'curl -k -u admin:Sup3rSecret "https://x:8089/y?output_mode=json" -H "Authorization: Splunk abc.def.tok" ' +
        'password=hunter2 https://usr:pw111@host/z Cookie: splunkd_8000=cookieval1; ' +
        'curl -uadmin:Att4ched x; curl --user=root:Eq4als y; splunk search q -auth admin:CliPw1; ' +
        'SPLUNK_PASS=EnvPw2 ./run.sh; api_key: K3yV4lue';
    const scr = mod.scrubPaste(CRED);
    for (const secret of ['Sup3rSecret', 'abc.def.tok', 'hunter2', 'pw111', 'cookieval1', 'Att4ched', 'Eq4als', 'CliPw1', 'EnvPw2', 'K3yV4lue']) {
        check(`scrub.${secret}`, scr.indexOf(secret) === -1, scr.slice(0, 200));
    }
    check('scrub.keepsUrl', scr.indexOf('output_mode=json') !== -1);
    const big = 'x'.repeat(mod.MAX_INGEST_PASTE_CHARS + 500);
    const scrBig = mod.scrubPaste(big);
    check('scrub.cap', scrBig.length <= mod.MAX_INGEST_PASTE_CHARS + 100 && scrBig.indexOf('[truncated') !== -1);

    // --- evaluator (blocker B2: mirror the generator) ---------------------------
    // Session 154 (the Data TA's fix 4d): a bare `*` ANYWHERE in the include
    // list is pass-all — before it, `*, linux/cron` kept only cron (the three
    // pins below were the inverse until this change).
    check('b2.mixedStarPassAll', mod.isPassAllInclude(['*', 'linux/cron']) === true);
    check('b2.mixedStarKeepsOthers', mod.typeDropStatus('squid:access', facts({ includeFilters: ['*', 'linux/cron'] })) === 'kept');
    check('b2.mixedStarKeepsNamed', mod.typeDropStatus('linux:cron', facts({ includeFilters: ['*', 'linux/cron'] })) === 'kept');
    check('b2.excludeStarInert', mod.typeDropStatus('squid:access', facts({ excludeFilters: ['*'] })) === 'kept');
    check('b2.allSlashlessPassAll', mod.isPassAllInclude(['foo', 'bar']) === true);
    check('b2.multiSlashNothing', mod.typeDropStatus('squid:access', facts({ includeFilters: ['proxy/squid/extra'] })) === 'dropped');
    check('b2.starStarInMixed', mod.isPassAllInclude(['linux/cron', '*/*']) === true);
    check('eval.passAllDefault', mod.typeDropStatus('squid:access', facts({})) === 'kept');
    check('eval.excluded', mod.typeDropStatus('sap:hana:audit', facts({ excludeFilters: ['hana/hanaaudit'] })) === 'dropped');
    check('eval.excludeWins', mod.typeDropStatus('squid:access', facts({ includeFilters: ['proxy/*'], excludeFilters: ['proxy/squid'] })) === 'dropped');
    check('eval.notIncluded', mod.typeDropStatus('sap:hana:audit', facts({ includeFilters: ['linux/*'] })) === 'dropped');
    // Session 140: real LogServ data files Squid under proxy/squid (AWS) AND linux/proxy (Azure), and
    // pacemaker.log under linux/pacemaker (GCP) - a rule naming one layout drops only part of the type.
    check('eval.squidOneLayoutPartial', mod.typeDropStatus('squid:access', facts({ excludeFilters: ['proxy/squid'] })) === 'partial');
    check('eval.squidBothLayoutsDropped', mod.typeDropStatus('squid:access', facts({ excludeFilters: ['proxy/squid', 'linux/proxy'] })) === 'dropped');
    check('eval.linuxStarKeepsAzureSquid', mod.typeDropStatus('squid:store', facts({ includeFilters: ['linux/*'] })) === 'partial');
    check('eval.pacemakerSurvivesSlapdRule', mod.typeDropStatus('linux:slapd', facts({ excludeFilters: ['linux/slapd'] })) === 'partial');
    check('eval.winPartial', mod.typeDropStatus('XmlWinEventLog', facts({ excludeFilters: ['windows/WinEventLog:Security'] })) === 'partial');
    check('eval.winAll', mod.typeDropStatus('XmlWinEventLog', facts({ excludeFilters: ['windows/*'] })) === 'dropped');
    check('eval.disabledKept', mod.typeDropStatus('squid:access', facts({ filterEnabled: false, excludeFilters: ['proxy/squid'] })) === 'kept');
    check('eval.fallbackUnknown', mod.typeDropStatus('sap_logserv_logs', facts({})) === 'unknown');
    check('eval.multiPathPartial', mod.typeDropStatus('linux_messages_syslog', facts({ includeFilters: ['linux/messages'] })) === 'partial');
    check('eval.qmark', mod.fnmatchLite('cron', 'cro?') === true);
    // §15.8a-18: CASE-SENSITIVE, pinned on the one mixed-case family
    check('case.insensitiveInert', mod.typeDropStatus('XmlWinEventLog', facts({ excludeFilters: ['windows/wineventlog:*'] })) === 'kept');
    check('case.exactDrops', mod.typeDropStatus('XmlWinEventLog', facts({ excludeFilters: ['windows/WinEventLog:*'] })) === 'dropped');
    check('rule.namesExclude', mod.namedRuleFor(['proxy/squid'], facts({ excludeFilters: ['proxy/squid'] })).indexOf('proxy/squid') !== -1);
    // TAG map (§15.8a-5)
    check('tag.dns', JSON.stringify(mod.tagClzPaths(['dns'])) === JSON.stringify(['dns/binddns']));
    check('tag.dnsDropped', mod.pathsDropStatus(mod.tagClzPaths(['dns']), facts({ excludeFilters: ['dns/binddns'] })) === 'dropped');
    check('tag.unknownTagEmpty', mod.tagClzPaths(['web']).length === 0);

    // --- defaults fingerprint (§15.8a-12) ---------------------------------------
    const dflt = facts({ filterEnabled: false, daysInPast: 7, includeFilters: ['*/*'], excludeFilters: [] });
    check('defaults.shape', mod.isDefaultsShape(dflt) === true);
    check('defaults.liveDsNot', mod.isDefaultsShape(facts({ filterEnabled: false, daysInPast: 360, includeFilters: ['*'] })) === false);
    check('defaults.transformsNot', mod.isDefaultsShape(Object.assign(dflt, { inputShape: 'transforms-conf' })) === false);
    const dflt2 = facts({ filterEnabled: false, daysInPast: 7, includeFilters: ['*/*'], excludeFilters: [] });
    check('defaults.summaryHedged', mod.ingestFactsSummary(dflt2).indexOf('heavy forwarder') !== -1, mod.ingestFactsSummary(dflt2));
    check('defaults.summaryRelative', mod.ingestFactsSummary(facts({ filterEnabled: false, daysInPast: 360 })).indexOf('supplied configuration') !== -1);

    // --- confidence discipline (§15.8a-8) ----------------------------------------
    check('cap.freshParsed', mod.suppliedConfidenceCap(facts({}), NOW) === 'confirmed');
    check('cap.staleLikely', mod.suppliedConfidenceCap(facts({ suppliedAt: NOW - 8 * 86400 }), NOW) === 'likely');
    check('cap.boundaryConfirmed', mod.suppliedConfidenceCap(facts({ suppliedAt: NOW - 7 * 86400 }), NOW) === 'confirmed');
    check('cap.approxLikely', mod.suppliedConfidenceCap(facts({ filtersApproximate: true }), NOW) === 'likely');
    check('cap.partialPossible', mod.suppliedConfidenceCap(facts({ parseStatus: 'partial' }), NOW) === 'possible');
    check('cap.min', mod.minConfidence('confirmed', 'possible') === 'possible' && mod.minConfidence('likely', 'confirmed') === 'likely');

    // --- storage encoding + sanitize-on-read (§15.8a-22/24/25) --------------------
    const recP = mod.factsToRecord(facts({ scrubbedRaw: 'RAWDATA', parseStatus: 'parsed' }), '314');
    check('store.parsedNoRaw', recP.scrubbed_raw === '');
    const recU = mod.factsToRecord(facts({ scrubbedRaw: 'RAWDATA', parseStatus: 'unparsed' }), '314');
    check('store.unparsedKeepsRaw', recU.scrubbed_raw === 'RAWDATA');
    check('store.boolsAre01', recP.filter_enabled === 1 && recP.filters_approximate === 0);
    check('store.nullOmitted', !('cutoff_epoch' in recP));
    const f0 = facts({ cutoffEpoch: 1785628800, includeFilters: ['linux/*', 'hana/hanaaudit'], excludeFilters: ['proxy/squid'] });
    const rt = mod.looksLikeIngestFacts(mod.factsToRecord(f0, '314'), NOW);
    check('rt.roundTrip', rt !== null && rt.cutoffEpoch === 1785628800 && JSON.stringify(rt.includeFilters) === JSON.stringify(f0.includeFilters) && rt.excludeFilters[0] === 'proxy/squid' && rt.filterEnabled === true);
    const recB = mod.factsToRecord(f0, '314');
    check('clamp.futureSuppliedAtRejects', mod.looksLikeIngestFacts(Object.assign({}, recB, { supplied_at: NOW + 999999 }), NOW) === null);
    check('clamp.badShapeRejects', mod.looksLikeIngestFacts(Object.assign({}, recB, { input_shape: 'evil' }), NOW) === null);
    check('clamp.nonObjectRejects', mod.looksLikeIngestFacts('junk', NOW) === null);
    const fut = mod.looksLikeIngestFacts(Object.assign({}, recB, { cutoff_epoch: NOW + 10 * 86400 }), NOW);
    check('clamp.futureCutoffNulled', fut !== null && fut.cutoffEpoch === null);
    const bigDays = mod.looksLikeIngestFacts(Object.assign({}, recB, { days_in_past: 99999 }), NOW);
    check('clamp.bigDaysNulled', bigDays !== null && bigDays.daysInPast === null);
    const badPat = mod.looksLikeIngestFacts(Object.assign({}, recB, { include_filters_json: JSON.stringify(['linux/*', 'bad&pat/x']) }), NOW);
    check('clamp.badPatternDropped', badPat !== null && badPat.includeFilters.length === 1 && badPat.includeFilters[0] === 'linux/*');
    const manyPat = mod.looksLikeIngestFacts(
        Object.assign({}, recB, { include_filters_json: JSON.stringify(Array.from({ length: 200 }, (_x, i) => `a${i}/b`) ) }),
        NOW,
    );
    check('clamp.patternListCapped', manyPat !== null && manyPat.includeFilters.length === mod.INGEST_MAX_PATTERNS);

    // --- provenance + wording ------------------------------------------------------
    check('prov.recordedAs', mod.provenanceLine(facts({})).indexOf('Recorded as supplied by') === 0);
    check('prov.stale', mod.staleCaveatLine(facts({ suppliedAt: NOW - 9 * 86400 }), NOW) !== null);
    check('prov.fresh', mod.staleCaveatLine(facts({}), NOW) === null);

    // =====================================================================
    // §19.4/§19.8a-8..10 — the cloud-provider stamp.
    // =====================================================================
    const BS = String.fromCharCode(92);

    // Transforms paste: explicit stanza per provider.
    const CLOUD_BLOCK = (v: string): string =>
        '\n\n### BEGIN LOGSERV CLOUD_PROVIDER CONFIG - DO NOT EDIT MANUALLY ###\n' +
        '[logserv_set_cloud_provider]\nREGEX = .\nFORMAT = cloud_provider::' +
        v +
        '\nWRITE_META = true\n\n### END LOGSERV CLOUD_PROVIDER CONFIG ###';
    for (const v of ['aws', 'azure', 'gcp']) {
        const p = mod.parseIngestPaste(TC + CLOUD_BLOCK(v), NOW);
        check(`stamp.tc.${v}`, p.cloudProviderStamp === v, String(p.cloudProviderStamp));
    }
    // §19.8a-8 / mutation (b): a COMPLETE filter marker pair with NO cloud
    // stanza must leave the stamp NULL — never an inferred 'not_set'.
    check('stamp.tc.absenceIsNull', mod.parseIngestPaste(TC, NOW).cloudProviderStamp === null);
    const pteS = mod.parseIngestPaste(
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###\n\n### END LOGSERV FILTER CONFIG ###',
        NOW,
    );
    check('stamp.tc.emptyPairAbsenceIsNull', pteS.cloudProviderStamp === null, String(pteS.cloudProviderStamp));
    // Truncated paste (START without END): stamp stays null too.
    const ptcS = mod.parseIngestPaste(
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###\n# cut off here',
        NOW,
    );
    check('stamp.tc.truncatedNull', ptcS.cloudProviderStamp === null);
    // Bogus value: null + a parser note, never trusted.
    const pBogus = mod.parseIngestPaste(TC + CLOUD_BLOCK('evilcloud'), NOW);
    check('stamp.tc.bogusNull', pBogus.cloudProviderStamp === null && /not a known provider/.test(pBogus.parseNote), pBogus.parseNote);
    // Disabled path (empty filter pair) WITH a cloud stanza: recovered.
    const pDisStamp = mod.parseIngestPaste(
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###\n\n### END LOGSERV FILTER CONFIG ###' +
            CLOUD_BLOCK('azure'),
        NOW,
    );
    check(
        'stamp.tc.disabledPathCarries',
        pDisStamp.filterEnabled === false && pDisStamp.cloudProviderStamp === 'azure',
        `${String(pDisStamp.filterEnabled)}/${String(pDisStamp.cloudProviderStamp)}`,
    );
    // Settings-conf: the ONE shape that can carry the literal not_set.
    const psS = mod.parseIngestPaste(SC, NOW);
    check('stamp.sc.notSet', psS.cloudProviderStamp === 'not_set', String(psS.cloudProviderStamp));
    const psAws = mod.parseIngestPaste(SC.replace('cloud_provider = not_set', 'cloud_provider = aws'), NOW);
    check('stamp.sc.aws', psAws.cloudProviderStamp === 'aws');
    const psBad = mod.parseIngestPaste(SC.replace('cloud_provider = not_set', 'cloud_provider = evil'), NOW);
    check('stamp.sc.bogusNull', psBad.cloudProviderStamp === null);
    // REST shapes genuinely do not carry it — stays null even with the
    // cloud_provider_settings entry present in the paste.
    check('stamp.json.null', mod.parseIngestPaste(TWO, NOW).cloudProviderStamp === null);
    check('stamp.xml.null', mod.parseIngestPaste(XML, NOW).cloudProviderStamp === null);

    // Storage round-trip (M14): stamp set -> record emits -> read returns.
    const fStamp = facts({ cloudProviderStamp: 'gcp' });
    const recStamp = mod.factsToRecord(fStamp, '319');
    check('stamp.store.emits', recStamp.cloud_provider_stamp === 'gcp');
    const rtStamp = mod.looksLikeIngestFacts(recStamp, NOW);
    check('stamp.store.roundTrip', rtStamp !== null && rtStamp.cloudProviderStamp === 'gcp');
    // Omit-null (L1): no key when unknown; legacy rows read as null.
    const recNoStamp = mod.factsToRecord(facts({}), '319');
    check('stamp.store.nullOmitted', !('cloud_provider_stamp' in recNoStamp));
    const rtLegacy = mod.looksLikeIngestFacts(recNoStamp, NOW);
    check('stamp.store.legacyNull', rtLegacy !== null && rtLegacy.cloudProviderStamp === null);
    // Read allowlist: hand-POSTed junk / empty string -> null.
    const rtEvil = mod.looksLikeIngestFacts(Object.assign({}, recStamp, { cloud_provider_stamp: 'evil' }), NOW);
    check('stamp.store.evilNull', rtEvil !== null && rtEvil.cloudProviderStamp === null);
    const rtEmpty = mod.looksLikeIngestFacts(Object.assign({}, recStamp, { cloud_provider_stamp: '' }), NOW);
    check('stamp.store.emptyNull', rtEmpty !== null && rtEmpty.cloudProviderStamp === null);

    // knownStamp: undefined-safe by membership (older fixtures carry no field).
    const noField = facts({});
    delete (noField as Record<string, unknown>).cloudProviderStamp;
    check('stamp.knownUndefinedSafe', mod.knownStamp(noField) === null);
    check('stamp.knownNullFacts', mod.knownStamp(null) === null);
    check('stamp.knownValue', mod.knownStamp(facts({ cloudProviderStamp: 'aws' })) === 'aws');

    // Summary carries the stamp on ALL return paths (M10).
    check(
        'stamp.summary.enabled',
        mod.ingestFactsSummary(facts({ cloudProviderStamp: 'aws' })).indexOf('Cloud-provider stamp: aws') !== -1,
    );
    check(
        'stamp.summary.disabled',
        mod.ingestFactsSummary(facts({ filterEnabled: false, cloudProviderStamp: 'azure' })).indexOf('Cloud-provider stamp: azure') !== -1,
    );
    check(
        'stamp.summary.unknownEnabled',
        mod.ingestFactsSummary(facts({ filterEnabled: null, cloudProviderStamp: 'gcp' })).indexOf('Cloud-provider stamp: gcp') !== -1,
    );
    check(
        'stamp.summary.unparsed',
        mod.ingestFactsSummary(facts({ parseStatus: 'unparsed', cloudProviderStamp: 'not_set' })).indexOf('Cloud-provider stamp: not set') !== -1,
    );
    check(
        'stamp.summary.absentWhenUnknown',
        mod.ingestFactsSummary(facts({})).indexOf('Cloud-provider stamp') === -1,
    );

    // =====================================================================
    // §19.8a-6 (B6) — the generic re.escape inverse, fixtures GENERATED from
    // the real generator grammar: fnmatch.translate maps '*' -> '.*',
    // '?' -> '.', and each literal through re.escape — which on the TA's
    // VALIDATED segment grammar (alphanumeric * ? . - : _) escapes exactly
    // '.' and '-' (Python 3.7+; older Pythons escape ':' too, which the
    // generic inverse also covers). The mirror below reproduces that grammar
    // and was verified against the live Python (session 105);
    // check-diagnostics additionally pins the TA source uses
    // fnmatch.translate + the clz lookahead shape.
    // =====================================================================
    const pyFnmatchFragment = (seg: string): string => {
        let out = '';
        for (const ch of seg) {
            if (ch === '*') out += '.*';
            else if (ch === '?') out += '.';
            else if (ch === '.' || ch === '-') out += BS + ch;
            else out += ch;
        }
        return out;
    };
    const genClzRegex = (pattern: string): string => {
        const i = pattern.indexOf('/');
        const d = pyFnmatchFragment(pattern.slice(0, i));
        const s = pyFnmatchFragment(pattern.slice(i + 1));
        return (
            '^(?=.*"clz_dir"' + BS + 's*:' + BS + 's*"' + d + '")' +
            '(?=.*"clz_subdir"' + BS + 's*:' + BS + 's*"' + s + '")'
        );
    };
    const HARD_PATTERNS = ['linux-hardened/*', 'sap/file.log', 'win/WinEventLog:*'];
    const HARD_EXCLUDES = ['a-b_c/x-y'];
    // Session 154: the include gate is the drop + allow PAIR (the generator
    // always writes both; an allow without its drop reads as unrecoverable),
    // so this fixture now carries the drop stanza the real generator writes.
    const TC_HARD = [
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###',
        '[logserv_filter_include_drop]',
        'REGEX = .',
        'FORMAT = nullQueue',
        'DEST_KEY = queue',
        '',
        '[logserv_filter_include_allow]',
        'REGEX = ' + HARD_PATTERNS.map((p) => '(?:' + genClzRegex(p) + ')').join('|'),
        'FORMAT = indexQueue',
        'DEST_KEY = queue',
        '',
        '[logserv_filter_exclude]',
        'REGEX = ' + genClzRegex(HARD_EXCLUDES[0]),
        'FORMAT = nullQueue',
        'DEST_KEY = queue',
        '',
        '### END LOGSERV FILTER CONFIG ###',
    ].join('\n');
    const pHard = mod.parseIngestPaste(TC_HARD, NOW);
    check(
        'inverse.hardPatternsRecovered',
        JSON.stringify(pHard.includeFilters) === JSON.stringify(HARD_PATTERNS),
        JSON.stringify(pHard.includeFilters),
    );
    check(
        'inverse.hardExcludeRecovered',
        JSON.stringify(pHard.excludeFilters) === JSON.stringify(HARD_EXCLUDES),
        JSON.stringify(pHard.excludeFilters),
    );
    check('inverse.cleanParse', pHard.parseStatus === 'parsed', pHard.parseStatus);
    // The recovered patterns must EVALUATE correctly (the B6 consequence was
    // fnmatchLite mis-evaluation against a backslash-bearing pattern).
    const fHard = facts({ includeFilters: pHard.includeFilters, excludeFilters: [] });
    check('inverse.evaluates', mod.pathsDropStatus(['linux-hardened/messages'], fHard) === 'kept');
    // A trailing lone backslash (uninvertible) still degrades honestly.
    const TC_TRAIL = TC_HARD.replace('"x' + BS + '-y"', '"x' + BS + '-y' + BS + '"');
    const pTrail = mod.parseIngestPaste(TC_TRAIL, NOW);
    check('inverse.strayBackslashPartial', pTrail.parseStatus === 'partial', pTrail.parseStatus);

    // =====================================================================
    // §19.8a-7 (H17) — the read-side clamp is not silent.
    // =====================================================================
    const recClamp = mod.factsToRecord(facts({ includeFilters: ['linux/*'] }), '319');
    const rtClean = mod.looksLikeIngestFacts(recClamp, NOW);
    check('h17.cleanNotApprox', rtClean !== null && rtClean.filtersApproximate === false);
    const rtDropped = mod.looksLikeIngestFacts(
        Object.assign({}, recClamp, { include_filters_json: JSON.stringify(['linux/*', 'bad&pat/x']) }),
        NOW,
    );
    check('h17.droppedEntryApprox', rtDropped !== null && rtDropped.filtersApproximate === true);
    const rtCapped = mod.looksLikeIngestFacts(
        Object.assign({}, recClamp, {
            exclude_filters_json: JSON.stringify(Array.from({ length: 200 }, (_x, i) => `a${i}/b`)),
        }),
        NOW,
    );
    check('h17.cappedApprox', rtCapped !== null && rtCapped.filtersApproximate === true);
    const rtBadJson = mod.looksLikeIngestFacts(
        Object.assign({}, recClamp, { include_filters_json: 'not json at all' }),
        NOW,
    );
    check('h17.badJsonApprox', rtBadJson !== null && rtBadJson.filtersApproximate === true);

    // =====================================================================
    // §19.8a-18 — factsUsableForBoundary (shared by report + pointer).
    // =====================================================================
    check('usable.null', mod.factsUsableForBoundary(null) === false);
    check('usable.undefined', mod.factsUsableForBoundary(undefined) === false);
    check('usable.unparsed', mod.factsUsableForBoundary(facts({ parseStatus: 'unparsed' })) === false);
    check('usable.enabledUnknown', mod.factsUsableForBoundary(facts({ filterEnabled: null })) === false);
    check(
        'usable.defaultsShape',
        mod.factsUsableForBoundary(facts({ filterEnabled: false, daysInPast: 7, includeFilters: ['*/*'], excludeFilters: [] })) === false,
    );
    check('usable.parsedEnabled', mod.factsUsableForBoundary(facts({})) === true);
    check('usable.partialStillUsable', mod.factsUsableForBoundary(facts({ parseStatus: 'partial' })) === true);
    check(
        'usable.disabledNonDefaults',
        mod.factsUsableForBoundary(facts({ filterEnabled: false, daysInPast: 360 })) === true,
    );

    // =====================================================================
    // §19.8a-4 — ingestCutoffApplicable (the facts+window half + H10 belt).
    // =====================================================================
    const CUT30 = mod.cutoffFromDays(30, NOW);
    const okFx = facts({ cutoffEpoch: CUT30, daysInPast: 30 });
    check('applicable.true', mod.ingestCutoffApplicable(okFx, CUT30 - 10 * 86400, NOW) === true);
    check('applicable.nullFacts', mod.ingestCutoffApplicable(null, CUT30 - 86400, NOW) === false);
    check('applicable.unparsed', mod.ingestCutoffApplicable(facts({ parseStatus: 'unparsed', cutoffEpoch: CUT30 }), CUT30 - 86400, NOW) === false);
    check('applicable.disabled', mod.ingestCutoffApplicable(facts({ filterEnabled: false, cutoffEpoch: CUT30 }), CUT30 - 86400, NOW) === false);
    check('applicable.noCutoff', mod.ingestCutoffApplicable(facts({ cutoffEpoch: null }), CUT30 - 86400, NOW) === false);
    check('applicable.nullWinEnd', mod.ingestCutoffApplicable(okFx, null, NOW) === false);
    check('applicable.straddle', mod.ingestCutoffApplicable(okFx, CUT30 + 100, NOW) === false);
    /* H10 — the world-writable-row consistency belt: a fabricated
     * cutoff_epoch NEAR NOW alongside days_in_past=7 would otherwise let the
     * "dropped by design" story fire on a RECENT window. The recompute
     * (midnight-now - 7d) is far earlier than that winEnd, so the belt
     * declines. */
    const poisoned = facts({ cutoffEpoch: NOW - 100, daysInPast: 7 });
    check('applicable.h10PoisonedDeclines', mod.ingestCutoffApplicable(poisoned, NOW - 3600, NOW) === false);
    // Consistent facts still pass with daysInPast present (the belt is
    // implied-true for honest rows: recomputed only slides forward).
    check('applicable.h10ConsistentPasses', mod.ingestCutoffApplicable(okFx, CUT30 - 86400, NOW) === true);
    // transforms shape carries no daysInPast — the belt is skipped by design.
    check(
        'applicable.noDaysSkipsBelt',
        mod.ingestCutoffApplicable(facts({ cutoffEpoch: NOW - 7200, daysInPast: null }), NOW - 3600 * 3, NOW) === true,
    );

    // --- KV client (fake FetchLike) --------------------------------------------------
    type Call = { url: string; method: string; body?: string };
    const mkFetch = (script: Array<{ ok: boolean; status: number; json?: unknown }>) => {
        const calls: Call[] = [];
        const f = (url: string, init?: { method?: string; body?: string }) => {
            calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
            const next = script.shift() || { ok: false, status: 599 };
            return Promise.resolve({
                ok: next.ok,
                status: next.status,
                json: () => Promise.resolve(next.json),
            });
        };
        return { f, calls };
    };

    // write: overwrite path
    {
        const { f, calls } = mkFetch([{ ok: true, status: 200 }]);
        const res = await mod.writeIngestFacts(facts({}), '314', f);
        check('kv.overwriteOk', res.ok === true && calls.length === 1 && calls[0].url.indexOf('/latest') !== -1 && calls[0].method === 'POST');
    }
    // write: 404 -> insert
    {
        const { f, calls } = mkFetch([
            { ok: false, status: 404 },
            { ok: true, status: 201 },
        ]);
        const res = await mod.writeIngestFacts(facts({}), '314', f);
        check('kv.insertOn404', res.ok === true && calls.length === 2 && calls[1].url.indexOf('/latest') === -1);
        const body = JSON.parse(calls[1].body || '{}');
        check('kv.insertCarriesKey', body._key === 'latest');
    }
    // write: 409 first-paste race -> retry /latest (§15.8a-26)
    {
        const { f, calls } = mkFetch([
            { ok: false, status: 404 },
            { ok: false, status: 409 },
            { ok: true, status: 200 },
        ]);
        const res = await mod.writeIngestFacts(facts({}), '314', f);
        check('kv.raceRetry', res.ok === true && calls.length === 3 && calls[2].url.indexOf('/latest') !== -1);
    }
    // write: hard failure surfaces reason
    {
        const { f } = mkFetch([{ ok: false, status: 403 }]);
        const res = await mod.writeIngestFacts(facts({}), '314', f);
        check('kv.failureReason', res.ok === false && res.reason.indexOf('403') !== -1);
    }
    // read: 404 = not supplied, no error
    {
        const { f } = mkFetch([{ ok: false, status: 404 }]);
        const res = await mod.fetchIngestFacts(f, NOW);
        check('kv.read404', res.facts === null && res.error === null);
    }
    // read: valid row round-trips; oversized raw is excerpt-truncated (§15.8a-23)
    {
        const row = mod.factsToRecord(facts({ parseStatus: 'unparsed', scrubbedRaw: 'y'.repeat(6000) }), '314');
        const { f } = mkFetch([{ ok: true, status: 200, json: row }]);
        const res = await mod.fetchIngestFacts(f, NOW);
        check(
            'kv.readExcerptTruncated',
            res.facts !== null && res.facts.scrubbedRaw.length <= mod.INGEST_RAW_EXCERPT_CHARS + 120 && res.facts.scrubbedRaw.indexOf('[excerpt') !== -1,
        );
    }
    // read: junk row reads as never-supplied
    {
        const { f } = mkFetch([{ ok: true, status: 200, json: { garbage: true } }]);
        const res = await mod.fetchIngestFacts(f, NOW);
        check('kv.junkReadsNull', res.facts === null && res.error === null);
    }

    // =====================================================================
    // §20.8a-15 — space-delimited SQL/CLI secret shapes (the review's five
    // probe strings; full-length raw samples put statement text in the PDF)
    // =====================================================================
    {
        const s = mod.scrubPaste as (t: string) => string;
        check(
            's20.scrub.sqlPasswordDq',
            s('CREATE USER FOO PASSWORD "Abc123!"').indexOf('Abc123!') === -1,
            'double-quoted SQL PASSWORD',
        );
        check(
            's20.scrub.sqlPasswordSq',
            s("ALTER USER SYSTEM PASSWORD 'S3cret!'").indexOf('S3cret!') === -1,
            'single-quoted SQL PASSWORD',
        );
        check(
            's20.scrub.identifiedBy',
            s('CONNECT scott IDENTIFIED BY tiger').indexOf('tiger') === -1,
            'IDENTIFIED BY',
        );
        check(
            's20.scrub.shortFlagSpaced',
            s('sqlcmd -S host -U sa -P Hunter2').indexOf('Hunter2') === -1,
            'spaced -P',
        );
        check(
            's20.scrub.shortFlagAttached',
            s('mysql -u root -pHunter2').indexOf('Hunter2') === -1,
            'attached -pXxx (non-lowercase first char)',
        );
        check(
            's20.scrub.longPassFlag',
            s('cmd --password Hunter2 go').indexOf('Hunter2') === -1,
            '--password x',
        );
        check(
            's20.scrub.flagWordSurvives',
            s('run -parameter value').indexOf('-parameter') !== -1,
            'a lowercase flag word must NOT be mangled by the attached rule',
        );
    }

    // =====================================================================
    // §20.8a-3 — the redactor is de-quadraticized (bounded email local part)
    // =====================================================================
    {
        const pii = require('./piiRedaction') as { redactFreeTextPii: (t: string) => string };
        check(
            's20.redact.realEmail',
            pii.redactFreeTextPii('mail bob.smith@example.com now').indexOf('bob.smith@example.com') === -1 &&
                pii.redactFreeTextPii('a.b%c+d@sub.domain.co.uk x').indexOf('sub.domain.co.uk') === -1,
            'real addresses still redact after the bound',
        );
        const start = Date.now();
        pii.redactFreeTextPii('A'.repeat(200_000)); // no '@' — the quadratic shape
        const ms = Date.now() - start;
        check(
            's20.redact.linearOnNoAt',
            ms < 5_000,
            `a 200K no-'@' run took ${ms} ms — the unbounded local part is back (§20.8a-3: ~53 s unbounded, ~68 ms bounded)`,
        );
    }

    // =====================================================================
    // Session 154 — the Data TA's source filters + the new generated shape
    // (design s154 §4/§5/§5a). The golden REGEX strings below are copied
    // from the design's §5a "Golden examples" (byte-verified against the
    // design file by testing/fnfilter_s154/scratch/app_doctor/
    // design_cross_check.js); C_SKIP / C_GAP are its SKIP and LA lines.
    // =====================================================================
    const C_SKIP = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")`;
    const C_GAP = String.raw`(?:(?!"_raw")[^\n])*?`;
    const G_LINUX_SECURE = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"linux")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"linux_secure"))`;
    const G_ZYPPER = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/zypper\.log"))`;
    const G_HANA_STAR = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"hana")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"[^"]*"))`;
    const G_YAST2 = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/YaST2\/[^"]*"))`;
    const G_SAPROUTER = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"clz_dir"\s*:\s*"sap")(?=(?:(?!"_raw")[^\n])*?"clz_subdir"\s*:\s*"saprouter")(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/messages"))`;
    // design s154 section 5b "New golden examples" (linear * translation), copied
    // from the design file by testing/fnfilter_s154/scratch/r2_app/design_goldens.py
    // (insert, then check: byte-equal)
    const G5B_TRACE = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/usr\/sap\/(?>[^"]*?\/trace\/)[^"]*"))`;
    const G5B_ZYPPER = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"(?>[^"]*?zypper)[^"]*"))`;
    const G5B_HDB = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/usr\/sap\/(?>[^"]*?\/HDB)(?>[^"]*?\/)(?>[^"]*?\/trace\/)[^"]*\.trc"))`;
    const G5B_RUN = String.raw`(?:^|"_raw"\s*:\s*"(?:[^"\\]++|\\.)*+")(?:(?=(?:(?!"_raw")[^\n])*?"source"\s*:\s*"\/var\/log\/[^"]*\/x\.log"))`;

    // The module's shape constants ARE the contract.
    check('s154.const.skip', mod.TA_FILTER_REGEX_SKIP === C_SKIP, String(mod.TA_FILTER_REGEX_SKIP));
    check('s154.const.gap', mod.TA_FILTER_REGEX_GAP === C_GAP, String(mod.TA_FILTER_REGEX_GAP));
    check('s154.const.skipPrefixesGoldens', [G_LINUX_SECURE, G_ZYPPER, G_HANA_STAR, G_YAST2, G_SAPROUTER].every((g) => g.indexOf(C_SKIP) === 0));
    check('s154.const.note', mod.SOURCE_RULES_NOTE === 'source rules may drop or keep some files of a folder');

    // A mirror of the generator's §5a text, anchored to the goldens below
    // (the mirror is only trusted because it reproduces all five exactly).
    const genFrag = (p: string): string => {
        let out = '';
        for (const ch of p) {
            if (ch === '*') out += '[^"]*';
            else if (ch === '?') out += '[^"]';
            else if (/^[A-Za-z0-9_]$/.test(ch)) out += ch;
            else out += BS + ch;
        }
        return out;
    };
    const genLA = (key: string, frag: string): string =>
        '(?=' + C_GAP + '"' + key + '"' + BS + 's*:' + BS + 's*"' + frag + '")';
    const genFolder = (p: string): string => {
        const i = p.indexOf('/');
        return genLA('clz_dir', genFrag(p.slice(0, i))) + genLA('clz_subdir', genFrag(p.slice(i + 1)));
    };
    const genSource = (e: string): string => {
        const eq = e.indexOf('=');
        return eq === -1
            ? genLA('source', genFrag(e))
            : genFolder(e.slice(0, eq)) + genLA('source', genFrag(e.slice(eq + 1)));
    };
    const genChunk = (entries: string[]): string => C_SKIP + '(?:' + entries.join('|') + ')';
    check('s154.mirror.linuxSecure', genChunk([genFolder('linux/linux_secure')]) === G_LINUX_SECURE, genChunk([genFolder('linux/linux_secure')]));
    check('s154.mirror.zypper', genChunk([genSource('/var/log/zypper.log')]) === G_ZYPPER, genChunk([genSource('/var/log/zypper.log')]));
    check('s154.mirror.hanaStar', genChunk([genFolder('hana/*')]) === G_HANA_STAR);
    check('s154.mirror.yast2', genChunk([genSource('/var/log/YaST2/*')]) === G_YAST2);
    check('s154.mirror.saprouter', genChunk([genSource('sap/saprouter=/var/log/messages')]) === G_SAPROUTER);

    // Paste builders: the generator's stanza layout (REGEX, FORMAT, DEST_KEY,
    // LOOKAHEAD) inside the FILTER marker pair.
    const MSTART = '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###';
    const MEND = '### END LOGSERV FILTER CONFIG ###';
    const stz = (name: string, regex: string, format = 'nullQueue'): string =>
        ['[' + name + ']', 'REGEX = ' + regex, 'FORMAT = ' + format, 'DEST_KEY = queue', 'LOOKAHEAD = 100000', ''].join('\n');
    const blk = (...stanzas: string[]): string => [MSTART].concat(stanzas).concat([MEND]).join('\n');
    const DROP = stz('logserv_filter_include_drop', '.');
    const allowS = (rx: string, n = 1): string =>
        stz(n === 1 ? 'logserv_filter_include_allow' : `logserv_filter_include_allow_${n}`, rx, 'indexQueue');
    const incSrcS = (rx: string, n = 1): string =>
        stz(n === 1 ? 'logserv_filter_include_sources' : `logserv_filter_include_sources_${n}`, rx, 'indexQueue');
    const excS = (rx: string, n = 1): string =>
        stz(n === 1 ? 'logserv_filter_exclude' : `logserv_filter_exclude_${n}`, rx);
    const excSrcS = (rx: string, n = 1): string =>
        stz(n === 1 ? 'logserv_filter_exclude_sources' : `logserv_filter_exclude_sources_${n}`, rx);
    const TIMES = stz('logserv_filter_time_drop', RX1);
    const J = (v: unknown): string => JSON.stringify(v);
    const P = (t: string): any => mod.parseIngestPaste(t, NOW);

    // --- the five design goldens parsed back to their patterns -------------
    {
        const p1 = P(blk(DROP, allowS(G_LINUX_SECURE)));
        check('s154.golden.linuxSecure', J(p1.includeFilters) === J(['linux/linux_secure']) && p1.parseStatus === 'parsed' && p1.filterEnabled === true, J(p1));
        const p2 = P(blk(excSrcS(G_ZYPPER)));
        check('s154.golden.zypper', J(p2.excludeSources) === J(['/var/log/zypper.log']) && p2.parseStatus === 'parsed', J(p2));
        check('s154.golden.zypperNoFolderLists', p2.includeFilters.length === 0 && p2.excludeFilters.length === 0 && p2.includeSources.length === 0);
        const p3 = P(blk(excS(G_HANA_STAR)));
        check('s154.golden.hanaStar', J(p3.excludeFilters) === J(['hana/*']) && p3.parseStatus === 'parsed', J(p3));
        const p4 = P(blk(excSrcS(G_YAST2)));
        check('s154.golden.yast2', J(p4.excludeSources) === J(['/var/log/YaST2/*']) && p4.parseStatus === 'parsed', J(p4));
        const p5 = P(blk(excSrcS(G_SAPROUTER)));
        check('s154.golden.saprouter', J(p5.excludeSources) === J(['sap/saprouter=/var/log/messages']) && p5.parseStatus === 'parsed', J(p5));
        // the same source goldens as INCLUDE sources behind a gate
        const p6 = P(blk(DROP, allowS(G_HANA_STAR), incSrcS(G_YAST2)));
        check('s154.golden.includeSources', J(p6.includeSources) === J(['/var/log/YaST2/*']) && J(p6.includeFilters) === J(['hana/*']) && p6.parseStatus === 'parsed', J(p6));
        check('s154.golden.approx', p1.filtersApproximate === true && p1.inputShape === 'transforms-conf');
    }

    // --- a full current-shape file: six stanza families + cloud + CRLF ------
    const FULL = blk(
        DROP,
        allowS(genChunk([genFolder('hana/*'), genFolder('linux/linux_secure')])),
        incSrcS(genChunk([genSource('/usr/sap/*/trace/*'), genSource('linux/linux_secure=/var/log/sssd/*')])),
        TIMES,
        excS(genChunk([genFolder('linux/cron')])),
        excSrcS(genChunk([genSource('/var/log/zypper.log'), genSource('/var/log/YaST2/*'), genSource('sap/saprouter=/var/log/messages')])),
    ) + CLOUD_BLOCK('azure');
    {
        const pf = P(FULL);
        check('s154.full.parsed', pf.parseStatus === 'parsed' && pf.filterEnabled === true, `${pf.parseStatus}: ${pf.parseNote}`);
        check('s154.full.include', J(pf.includeFilters) === J(['hana/*', 'linux/linux_secure']), J(pf.includeFilters));
        check('s154.full.includeSources', J(pf.includeSources) === J(['/usr/sap/*/trace/*', 'linux/linux_secure=/var/log/sssd/*']), J(pf.includeSources));
        check('s154.full.exclude', J(pf.excludeFilters) === J(['linux/cron']), J(pf.excludeFilters));
        check('s154.full.excludeSources', J(pf.excludeSources) === J(['/var/log/zypper.log', '/var/log/YaST2/*', 'sap/saprouter=/var/log/messages']), J(pf.excludeSources));
        check('s154.full.cutoff', pf.cutoffEpoch === 1785628800, String(pf.cutoffEpoch));
        check('s154.full.stamp', pf.cloudProviderStamp === 'azure');
        const pc = P(FULL.split('\n').join('\r\n'));
        check('s154.full.crlf', pc.parseStatus === 'parsed' && J(pc.excludeSources) === J(pf.excludeSources) && J(pc.includeFilters) === J(pf.includeFilters), pc.parseStatus);
        // the old shape still has no source lists
        const pOld = P(TC);
        check('s154.old.noSourceLists', pOld.includeSources.length === 0 && pOld.excludeSources.length === 0 && pOld.parseStatus === 'parsed');
        check('s154.old.unchanged', J(pOld.includeFilters) === J(['linux/*', 'hana/hanaaudit']) && J(pOld.excludeFilters) === J(['linux/cron']));
    }

    // --- round trip over the whole grammar (seeded, deterministic) ----------
    {
        let seed = 154;
        const rnd = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const SEG = 'abcxyzABCXYZ0189*?._:-';
        const SRC = 'abcxyzABCXYZ0189/._:*?+@~-';
        const word = (alphabet: string, min: number, max: number): string => {
            let s = '';
            const len = min + rnd(max - min + 1);
            for (let k = 0; k < len; k += 1) s += alphabet.charAt(rnd(alphabet.length));
            return s;
        };
        const folders: string[] = [];
        const sources: string[] = [];
        for (let k = 0; k < 200; k += 1) {
            folders.push(word(SEG, 1, 8) + '/' + word(SEG, 1, 8));
            let s = word(SRC, 1, 40);
            if (!/[^*?/]/.test(s)) s += 'x';
            sources.push(rnd(3) === 0 ? word(SEG, 1, 6) + '/' + word(SEG, 1, 6) + '=' + s : s);
        }
        const uniq = (a: string[]): string[] => a.filter((v, i) => a.indexOf(v) === i);
        const pr = P(blk(DROP, allowS(genChunk(folders.map(genFolder))), incSrcS(genChunk(sources.map(genSource))), excS(genChunk(folders.map(genFolder))), excSrcS(genChunk(sources.map(genSource)))));
        check('s154.roundTrip.status', pr.parseStatus === 'parsed', `${pr.parseStatus}: ${pr.parseNote}`);
        check('s154.roundTrip.folders', J(pr.includeFilters) === J(uniq(folders)) && J(pr.excludeFilters) === J(uniq(folders)), J(pr.includeFilters).slice(0, 300));
        check('s154.roundTrip.sources', J(pr.includeSources) === J(uniq(sources)) && J(pr.excludeSources) === J(uniq(sources)), J(pr.excludeSources).slice(0, 300));
        // every allowed non-word character, escaped, in both list kinds
        const ALL = ['a-b.c:d_e/f?g*h', 'WinEventLog:*/x'];
        const ALLS = ['/var/log/a+b@c~d-e.f:g_h', 'Unix:ListeningPorts', 'ps', '?x', 'd.d/s-s=/p*q?r'];
        const pa = P(blk(DROP, allowS(genChunk(ALL.map(genFolder))), excSrcS(genChunk(ALLS.map(genSource)))));
        check('s154.roundTrip.allChars', J(pa.includeFilters) === J(ALL) && J(pa.excludeSources) === J(ALLS) && pa.parseStatus === 'parsed', J(pa));
    }

    // --- chunked lists: merged in chunk order, gaps never read as whole ----
    {
        const c1 = genChunk([genFolder('linux/cron'), genFolder('linux/warn')]);
        const c2 = genChunk([genFolder('proxy/squid'), genFolder('linux/cron')]);
        const c3 = genChunk([genFolder('dns/binddns')]);
        // stanza order in the text deliberately not the chunk order
        const pk = P(blk(excS(c3, 3), excS(c1), excS(c2, 2)));
        check('s154.chunk.merged', J(pk.excludeFilters) === J(['linux/cron', 'linux/warn', 'proxy/squid', 'dns/binddns']) && pk.parseStatus === 'parsed', `${J(pk.excludeFilters)} ${pk.parseStatus}`);
        const s1 = genChunk([genSource('/var/log/zypper.log')]);
        const s2 = genChunk([genSource('/var/log/YaST2/*')]);
        const pks = P(blk(DROP, allowS(G_HANA_STAR), incSrcS(s1), incSrcS(s2, 2), excSrcS(s2), excSrcS(s1, 2)));
        check('s154.chunk.sourcesMerged', J(pks.includeSources) === J(['/var/log/zypper.log', '/var/log/YaST2/*']) && J(pks.excludeSources) === J(['/var/log/YaST2/*', '/var/log/zypper.log']) && pks.parseStatus === 'parsed', J(pks));
        const pGap = P(blk(excS(c1), excS(c3, 3)));
        check('s154.chunk.gapPartial', pGap.parseStatus === 'partial', pGap.parseStatus);
        const pNo1 = P(blk(excS(c2, 2)));
        check('s154.chunk.noFirstPartial', pNo1.parseStatus === 'partial', pNo1.parseStatus);
        const pDup = P(blk(excS(c1), excS(c2)));
        check('s154.chunk.duplicatePartial', pDup.parseStatus === 'partial', pDup.parseStatus);
        const pOne = P(blk(excS(c1), stz('logserv_filter_exclude_1', c2)));
        check('s154.chunk.explicitOneIsUnknown', pOne.parseStatus === 'partial' && /Unrecognized/.test(pOne.parseNote), pOne.parseNote);
        // a chunk-only paste without markers still parses as a (partial) filter paste
        const pChunkOnly = P(excS(c2, 2));
        check('s154.chunk.chunkOnlyPaste', pChunkOnly.inputShape === 'transforms-conf' && pChunkOnly.filterEnabled === true && pChunkOnly.parseStatus === 'partial', `${pChunkOnly.inputShape}/${pChunkOnly.parseStatus}`);
        const pNoRegex = P(blk(excS(c1), '[logserv_filter_exclude_2]\nFORMAT = nullQueue\nDEST_KEY = queue\n'));
        check('s154.chunk.chunkWithoutRegexPartial', pNoRegex.parseStatus === 'partial', pNoRegex.parseStatus);
    }

    // --- exact stanza names: _exclude never reads _exclude_sources / _2 -----
    {
        const pe = P(blk(excSrcS(G_ZYPPER), excSrcS(G_YAST2, 2)));
        check('s154.exact.sourcesNotFolders', pe.excludeFilters.length === 0 && J(pe.excludeSources) === J(['/var/log/zypper.log', '/var/log/YaST2/*']), J(pe));
        const pb = P(blk(excSrcS(G_ZYPPER), excS(G_HANA_STAR)));
        check('s154.exact.bothLists', J(pb.excludeFilters) === J(['hana/*']) && J(pb.excludeSources) === J(['/var/log/zypper.log']) && pb.parseStatus === 'parsed', J(pb));
        const pa = P(blk(DROP, allowS(G_LINUX_SECURE), incSrcS(G_ZYPPER)));
        check('s154.exact.allowNotSources', J(pa.includeFilters) === J(['linux/linux_secure']) && J(pa.includeSources) === J(['/var/log/zypper.log']), J(pa));
    }

    // --- source-only pastes (understand_critic "Missed places" 5) ----------
    {
        const po = P(excSrcS(G_ZYPPER));
        check('s154.srcOnly.enabled', po.filterEnabled === true && po.inputShape === 'transforms-conf');
        check('s154.srcOnly.partialNotPassAll', po.parseStatus === 'partial' && /only source-rule stanzas/.test(po.parseNote), `${po.parseStatus}: ${po.parseNote}`);
        check('s154.srcOnly.listRecovered', J(po.excludeSources) === J(['/var/log/zypper.log']));
        const pi = P(incSrcS(G_ZYPPER));
        check('s154.srcOnly.includePartial', pi.parseStatus === 'partial', pi.parseStatus);
        // the same stanza inside a COMPLETE marker pair is the whole block
        const pw = P(blk(excSrcS(G_ZYPPER)));
        check('s154.srcOnly.wholeBlockParsed', pw.parseStatus === 'parsed' && pw.includeFilters.length === 0, pw.parseStatus);
        // a START marker without END does not make it whole
        const ph = P(MSTART + '\n' + excSrcS(G_ZYPPER));
        check('s154.srcOnly.halfMarkerPartial', ph.parseStatus === 'partial', ph.parseStatus);
        // a folder stanza alone keeps today's reading (parsed)
        const pf = P(excS(G_HANA_STAR));
        check('s154.srcOnly.folderFragmentUnchanged', pf.parseStatus === 'parsed' && J(pf.excludeFilters) === J(['hana/*']), pf.parseStatus);
    }

    // --- include-gate consistency + unknown stanzas --------------------------
    {
        check('s154.gate.sourcesWithoutGate', P(blk(incSrcS(G_ZYPPER))).parseStatus === 'partial');
        check('s154.gate.dropWithoutAllow', P(blk(DROP, excS(G_HANA_STAR))).parseStatus === 'partial');
        check('s154.gate.allowWithoutDrop', P(blk(allowS(G_HANA_STAR))).parseStatus === 'partial');
        const pu = P(blk(DROP, allowS(G_HANA_STAR), stz('logserv_filter_mystery', G_ZYPPER)));
        check('s154.gate.unknownStanza', pu.parseStatus === 'partial' && /Unrecognized filter stanza/.test(pu.parseNote) && /logserv_filter_mystery/.test(pu.parseNote), pu.parseNote);
        // a collapsed one-line paste never reads as "disabled"
        const pl = P(blk(DROP, allowS(G_HANA_STAR)).split('\n').join(' '));
        check('s154.gate.collapsedNotDisabled', pl.filterEnabled !== false, String(pl.filterEnabled));
    }

    // --- hostile / foreign current-shape REGEXes degrade to partial ----------
    {
        const bad = (label: string, paste: string, extra?: (p: any) => boolean): void => {
            const p = P(paste);
            check(`s154.bad.${label}`, p.parseStatus === 'partial' && (!extra || extra(p)), `${p.parseStatus} ${J(p.excludeSources)} ${J(p.excludeFilters)} ${J(p.includeFilters)}`);
        };
        const LAsrc = (frag: string): string => genLA('source', frag);
        bad('wordEscape', blk(excSrcS(genChunk([LAsrc('a' + BS + 'sb')]))));
        bad('dotStarFragment', blk(excSrcS(genChunk([LAsrc(BS + '/var' + BS + '/.*')]))));
        bad('charClassFragment', blk(excSrcS(genChunk([LAsrc('[a-z]x')]))));
        bad('emptyAlternative', blk(excSrcS(genChunk([genSource('/var/log/zypper.log'), '']))), (p) => J(p.excludeSources) === J(['/var/log/zypper.log']));
        bad('emptyGroup', blk(excSrcS(genChunk([]))));
        bad('subdirFirst', blk(excS(genChunk([genLA('clz_subdir', 'cron') + genLA('clz_dir', 'linux')]))));
        bad('sourceInFolderStanza', blk(excS(genChunk([genFolder('linux/cron'), genSource('/var/log/x')]))), (p) => J(p.excludeFilters) === J(['linux/cron']));
        bad('folderInSourceStanza', blk(excSrcS(genChunk([genFolder('linux/cron')]))), (p) => p.excludeSources.length === 0);
        bad('trailingText', blk(excSrcS(G_ZYPPER + 'x')));
        bad('altered skip', blk(excSrcS(G_ZYPPER.replace(']++|', ']+|'))));
        bad('quoteInValue', blk(excSrcS(genChunk([LAsrc('a' + BS + '"b')]))));
        bad('allStarsSource', blk(excSrcS(genChunk([LAsrc('[^"]*')]))));
        bad('slashStarSource', blk(excSrcS(genChunk([LAsrc(BS + '/[^"]*')]))));
        bad('overlongSource', blk(excSrcS(genChunk([genSource('/' + 'a'.repeat(512))]))));
        bad('unknownKey', blk(excSrcS(genChunk([genLA('datasource', 'x')]))));
        // a combined entry whose source lookahead is broken must NOT be read
        // as the (broader) folder-only entry
        bad(
            'brokenCombinedNotFolder',
            blk(excSrcS(genChunk([genFolder('sap/saprouter') + genLA('source', '[a]')]))),
            (p) => p.excludeSources.length === 0,
        );
        // an entry is read only when it ENDS where an entry must end (at a
        // '|' or the group's close): a valid prefix followed by junk is not
        bad(
            'brokenFolderEntryNotRead',
            blk(excS(genChunk([genFolder('linux/cron') + genLA('source', '[a]')]))),
            (p) => p.excludeFilters.length === 0,
        );
        bad('brokenSourceEntryNotRead', blk(excSrcS(genChunk([genSource('/var/log/x') + 'junk']))), (p) => p.excludeSources.length === 0);
        // a header-looking text with no well-formed stanza name is not a
        // whole (pass-all) block even inside a complete marker pair
        bad('noWellFormedHeader', blk('[logserv_filter_ex-clude]\nREGEX = x\n'), (p) => p.filterEnabled === true);
        // resync: the good entry after a bad one is still recovered
        bad(
            'resync',
            blk(excSrcS(genChunk([genLA('source', '[a]'), genSource('/var/log/zypper.log')]))),
            (p) => J(p.excludeSources) === J(['/var/log/zypper.log']),
        );
        // an old-shape folder REGEX that yields nothing is foreign, not pass-all
        bad('foreignFolderRegex', blk(DROP, allowS('foo')));
        bad('folderStanzaWithoutRegex', blk(DROP, '[logserv_filter_include_allow]\nFORMAT = indexQueue\n'));
        bad('timeStanzaWithoutRegex', blk('[logserv_filter_time_drop]\nFORMAT = nullQueue\n'));
    }

    // =====================================================================
    // Session 154 round 2 — design s154 §5b, the LINEAR '*' translation:
    // split the pattern on runs of '*' into S0 .. Sk; k = 0 -> seg(S0);
    // k >= 1 -> seg(S0) + (?>[^"]*?seg(Si)) per MIDDLE segment + [^"]* +
    // seg(Sk). The §5a mirror above (genFrag) stays as the round-1 text the
    // inverse must still read as before; the §5b mirror below is trusted
    // only because it reproduces the four §5b goldens AND the five §5a
    // goldens exactly. Star runs collapse, so a pattern read back from
    // transforms.conf is the collapsed one.
    // =====================================================================
    {
        const S = '[^"]*';
        const O = '[^"]';
        const A = '(?>' + S + '?';
        check('s154b.const.fragStar', mod.TA_FILTER_FRAG_STAR === S, String(mod.TA_FILTER_FRAG_STAR));
        check('s154b.const.fragOne', mod.TA_FILTER_FRAG_ONE === O, String(mod.TA_FILTER_FRAG_ONE));
        check('s154b.const.atomOpen', mod.TA_FILTER_FRAG_ATOM_OPEN === '(?>[^"]*?', String(mod.TA_FILTER_FRAG_ATOM_OPEN));
        check('s154b.const.atomClose', mod.TA_FILTER_FRAG_ATOM_CLOSE === ')', String(mod.TA_FILTER_FRAG_ATOM_CLOSE));
        check('s154b.const.goldensCarryAtoms', [G5B_TRACE, G5B_ZYPPER, G5B_HDB].every((g) => g.indexOf(A) !== -1) && G5B_RUN.indexOf('(?>') === -1);
        check('s154b.const.skipPrefixesGoldens', [G5B_TRACE, G5B_ZYPPER, G5B_HDB, G5B_RUN].every((g) => g.indexOf(C_SKIP) === 0));

        // the §5b generator mirror (no backslash typed: BS + character)
        const starSegments = (p: string): string[] => {
            const segs: string[] = [''];
            let inRun = false;
            for (const ch of p) {
                if (ch === '*') {
                    if (!inRun) segs.push('');
                    inRun = true;
                } else {
                    segs[segs.length - 1] += ch;
                    inRun = false;
                }
            }
            return segs;
        };
        const seg = (s: string): string => {
            let out = '';
            for (const ch of s) {
                if (ch === '?') out += O;
                else if (/^[A-Za-z0-9_]$/.test(ch)) out += ch;
                else out += BS + ch;
            }
            return out;
        };
        const genFragL = (p: string): string => {
            const segs = starSegments(p);
            if (segs.length === 1) return seg(p);
            let out = seg(segs[0]);
            for (let k = 1; k < segs.length - 1; k += 1) out += A + seg(segs[k]) + ')';
            return out + S + seg(segs[segs.length - 1]);
        };
        const collapse = (p: string): string => starSegments(p).join('*');
        const genFolderL = (p: string): string => {
            const i = p.indexOf('/');
            return genLA('clz_dir', genFragL(p.slice(0, i))) + genLA('clz_subdir', genFragL(p.slice(i + 1)));
        };
        const genSourceL = (e: string): string => {
            const eq = e.indexOf('=');
            return eq === -1
                ? genLA('source', genFragL(e))
                : genFolderL(e.slice(0, eq)) + genLA('source', genFragL(e.slice(eq + 1)));
        };
        const GOLD_5B: Array<[string, string, string]> = [
            ['trace', '/usr/sap/*/trace/*', G5B_TRACE],
            ['zypper', '*zypper*', G5B_ZYPPER],
            ['hdb', '/usr/sap/*/HDB*/*/trace/*.trc', G5B_HDB],
            ['run', '/var/log/**/x.log', G5B_RUN],
        ];
        for (const [label, pat, golden] of GOLD_5B) {
            check(`s154b.mirror.${label}`, genChunk([genSourceL(pat)]) === golden, genChunk([genSourceL(pat)]));
        }
        // at most one '*': the §5b text IS the §5a text (5a goldens unchanged)
        check('s154b.mirror.linuxSecure5a', genChunk([genFolderL('linux/linux_secure')]) === G_LINUX_SECURE);
        check('s154b.mirror.zypper5a', genChunk([genSourceL('/var/log/zypper.log')]) === G_ZYPPER);
        check('s154b.mirror.hanaStar5a', genChunk([genFolderL('hana/*')]) === G_HANA_STAR);
        check('s154b.mirror.yast25a', genChunk([genSourceL('/var/log/YaST2/*')]) === G_YAST2);
        check('s154b.mirror.saprouter5a', genChunk([genSourceL('sap/saprouter=/var/log/messages')]) === G_SAPROUTER);
        check('s154b.mirror.collapse', collapse('/var/log/**/x.log') === '/var/log/*/x.log' && collapse('**a***b*') === '*a*b*' && collapse('ps') === 'ps');

        // --- the four §5b goldens parsed back to their (collapsed) patterns
        for (const [label, pat, golden] of GOLD_5B) {
            const pe = P(blk(excSrcS(golden)));
            check(`s154b.golden.${label}.exclude`, pe.parseStatus === 'parsed' && J(pe.excludeSources) === J([collapse(pat)]), `${pe.parseStatus} ${J(pe.excludeSources)} ${pe.parseNote}`);
            const pi = P(blk(DROP, allowS(G_HANA_STAR), incSrcS(golden)));
            check(`s154b.golden.${label}.include`, pi.parseStatus === 'parsed' && J(pi.includeSources) === J([collapse(pat)]) && J(pi.includeFilters) === J(['hana/*']), `${pi.parseStatus} ${J(pi.includeSources)}`);
        }
        check('s154b.golden.runCollapsed', J(P(blk(excSrcS(G5B_RUN))).excludeSources) === J(['/var/log/*/x.log']));
        // all four in ONE chunk, in order (the goldens' entries joined)
        const pAll = P(blk(excSrcS(genChunk(GOLD_5B.map(([, pat]) => genSourceL(pat))))));
        check('s154b.golden.oneChunk', pAll.parseStatus === 'parsed' && J(pAll.excludeSources) === J(GOLD_5B.map(([, pat]) => collapse(pat))), J(pAll.excludeSources));

        // --- multi-star folder entries (dir and subdir parts both linear)
        const FOLD_M = ['*a*u*d*t/*h*n*', 'l**x/c***n', '?i*u*x/l*_*e*', 'hana/*a*u*', '*:*/W*E*L*:*S*'];
        const fM = FOLD_M.map((p) => genChunk([genFolderL(p)]));
        check('s154b.folder.textHasAtoms', fM[0].indexOf(A) !== -1 && fM[1].indexOf(A) === -1, fM[0]);
        const pFM = P(blk(DROP, allowS(genChunk(FOLD_M.map(genFolderL))), excS(genChunk(FOLD_M.slice().reverse().map(genFolderL)))));
        check('s154b.folder.parsed', pFM.parseStatus === 'parsed', `${pFM.parseStatus}: ${pFM.parseNote}`);
        check('s154b.folder.include', J(pFM.includeFilters) === J(FOLD_M.map(collapse)), J(pFM.includeFilters));
        check('s154b.folder.exclude', J(pFM.excludeFilters) === J(FOLD_M.slice().reverse().map(collapse)), J(pFM.excludeFilters));
        check('s154b.folder.runRead', pFM.includeFilters.indexOf('l*x/c*n') !== -1 && pFM.includeFilters.indexOf('l**x/c***n') === -1);
        // the recovered folder pattern drives the evaluator as the original does
        const survFM = (path: string): boolean => mod.clzPathSurvives(path, facts({ includeFilters: pFM.includeFilters }));
        const survFMOrig = (path: string): boolean => mod.clzPathSurvives(path, facts({ includeFilters: FOLD_M }));
        const FM_PATHS = ['hana/hanaaudit', 'linux/cron', 'linux/linux_secure', 'lix/cn', 'linux/warn', 'dns/binddns', 'windows/WinEventLog:Security'];
        check(
            's154b.folder.evaluator',
            J(FM_PATHS.map(survFM)) === J([true, true, true, true, false, false, false]) && J(FM_PATHS.map(survFM)) === J(FM_PATHS.map(survFMOrig)),
            J(FM_PATHS.map(survFM)),
        );

        // --- combined entries with multi-star sources (and folders)
        const COMB_M = [
            'linux/linux_secure=/var/log/*/*.log',
            'l*n*x/*=*zypper*',
            'hana/*=/usr/sap/*/HDB*/*/trace/*.trc',
            'sap/s**r=/var/**/m*s*s',
            'linux/linux_secure=/var/log/YaST2/*',
            'proxy/squid=?a*b?c*',
        ];
        const pCM = P(blk(DROP, allowS(G_HANA_STAR), incSrcS(genChunk(COMB_M.map(genSourceL))), excSrcS(genChunk(COMB_M.map(genSourceL).concat([genSourceL('*zypper*')])))));
        check('s154b.combined.parsed', pCM.parseStatus === 'parsed', `${pCM.parseStatus}: ${pCM.parseNote}`);
        check('s154b.combined.include', J(pCM.includeSources) === J(COMB_M.map(collapse)), J(pCM.includeSources));
        check('s154b.combined.exclude', J(pCM.excludeSources) === J(COMB_M.map(collapse).concat(['*zypper*'])), J(pCM.excludeSources));
        check('s154b.combined.collapsedForm', pCM.excludeSources.indexOf('sap/s*r=/var/*/m*s*s') !== -1);
        // a combined entry whose multi-star source is foreign is never read as its folder
        const pCB = P(blk(excSrcS(genChunk([genFolderL('l*n*x/*') + genLA('source', A + 'a)' + 'b' + S + 'c')]))));
        check('s154b.combined.brokenNotFolder', pCB.parseStatus === 'partial' && pCB.excludeSources.length === 0 && pCB.excludeFilters.length === 0, J(pCB));

        // --- the §5a (round-1) text still reads as before -------------------
        const p5a = P(blk(excSrcS(genChunk([genLA('source', 'a' + S + 'b' + S + 'c'), genLA('source', S + S + 'x'), genSource('/usr/sap/*/HDB*/*/trace/*.trc')]))));
        check('s154b.old5a.multiStar', p5a.parseStatus === 'parsed' && J(p5a.excludeSources) === J(['a*b*c', '**x', '/usr/sap/*/HDB*/*/trace/*.trc']), `${p5a.parseStatus} ${J(p5a.excludeSources)}`);
        check('s154b.old5a.textDiffers', genSource('/usr/sap/*/HDB*/*/trace/*.trc') !== genSourceL('/usr/sap/*/HDB*/*/trace/*.trc') && genSource('/var/log/*.log') === genSourceL('/var/log/*.log'));
        // and the pre-session-154 fnmatch.translate shape is untouched
        const pOld2 = P(TC);
        check('s154b.oldFnmatch.unchanged', pOld2.parseStatus === 'parsed' && J(pOld2.includeFilters) === J(['linux/*', 'hana/hanaaudit']) && J(pOld2.excludeFilters) === J(['linux/cron']));

        // --- hostile '(?>' residue: never read, the scan resynchronizes -----
        const GOOD = genSourceL('/var/log/zypper.log');
        const hostileAtom = (label: string, frag: string): void => {
            const p = P(blk(excSrcS(genChunk([genLA('source', frag), GOOD]))));
            check(`s154b.hostile.${label}`, p.parseStatus === 'partial' && J(p.excludeSources) === J(['/var/log/zypper.log']), `${p.parseStatus} ${J(p.excludeSources)}`);
        };
        hostileAtom('atomLast', A + 'a)');
        hostileAtom('atomsLast', A + 'a)' + A + 'b)');
        hostileAtom('atomThenLiteral', A + 'a)' + 'b' + S + 'c');
        hostileAtom('atomThenOne', A + 'a)' + O + S + 'c');
        hostileAtom('atomThenEscape', A + 'a)' + BS + '.' + S + 'c');
        hostileAtom('atomEmpty', A + ')' + S + 'c');
        hostileAtom('atomHoldsStar', A + 'a' + S + 'b)' + S + 'c');
        hostileAtom('atomNested', A + A + 'a))' + S + 'c');
        hostileAtom('atomUnclosed', A + 'a' + S + 'c');
        hostileAtom('atomUnclosedAtEnd', A + 'abc');
        hostileAtom('atomAfterStar', S + A + 'a)' + S + 'c');
        hostileAtom('atomAfterStarAfterAtom', A + 'a)' + S + A + 'b)' + S + 'c');
        hostileAtom('starAfterLast', A + 'a)' + S + 'b' + S + 'c');
        hostileAtom('possessive', '(?>' + S + '+a)' + S + 'c');
        hostileAtom('greedy', '(?>' + S + 'a)' + S + 'c');
        hostileAtom('nonAtomicGroup', '(?:' + S + '?a)' + S + 'c');
        hostileAtom('fnmatchAtomic', '(?>.*?a).*c');
        hostileAtom('wordEscapeInAtom', A + BS + 's)' + S + 'c');
        hostileAtom('quoteInAtom', A + 'a' + BS + '")' + S + 'c');
        hostileAtom('escapedStar', 'a' + BS + '*b');
        hostileAtom('escapedQmark', BS + '?x');
        hostileAtom('escapedStarInAtom', A + BS + '*)' + S + 'c');
        hostileAtom('bareOpen', '(?>');
        // a folder whose dir part carries a residue atom is not a folder
        const pHF = P(blk(excS(genChunk([genLA('clz_dir', A + 'a)') + genLA('clz_subdir', 'b'), genFolderL('l*n*x/c*o*n')]))));
        check('s154b.hostile.folderAtomLast', pHF.parseStatus === 'partial' && J(pHF.excludeFilters) === J(['l*n*x/c*o*n']), `${pHF.parseStatus} ${J(pHF.excludeFilters)}`);
        // control: the same entries well-formed parse whole
        const pCtl = P(blk(excSrcS(genChunk([genLA('source', A + 'a)' + S + 'c'), GOOD]))));
        check('s154b.hostile.control', pCtl.parseStatus === 'parsed' && J(pCtl.excludeSources) === J(['*a*c', '/var/log/zypper.log']), `${pCtl.parseStatus} ${J(pCtl.excludeSources)}`);

        // --- round trip over the whole grammar with the §5b mirror ----------
        let seed = 1545;
        const rnd = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const SEGA = 'abcxyzA0_*?.:-**';
        const SRCA = 'abcxyzA0_/.:+@~-*?**';
        const word = (alphabet: string, min: number, max: number): string => {
            let s = '';
            const len = min + rnd(max - min + 1);
            for (let k = 0; k < len; k += 1) s += alphabet.charAt(rnd(alphabet.length));
            return s;
        };
        const folders: string[] = [];
        const sources: string[] = [];
        for (let k = 0; k < 250; k += 1) {
            folders.push(word(SEGA, 1, 9) + '/' + word(SEGA, 1, 9));
            let s = word(SRCA, 1, 40);
            if (!/[^*?/]/.test(s)) s += 'x';
            sources.push(rnd(3) === 0 ? word(SEGA, 1, 6) + '/' + word(SEGA, 1, 6) + '=' + s : s);
        }
        const uniq = (a: string[]): string[] => a.filter((v, i) => a.indexOf(v) === i);
        const fl = folders.map(genFolderL);
        const sl = sources.map(genSourceL);
        check('s154b.roundTrip.manyAtoms', fl.concat(sl).filter((x) => x.indexOf(A) !== -1).length > 100);
        const pr = P(blk(DROP, allowS(genChunk(fl)), incSrcS(genChunk(sl)), excS(genChunk(fl)), excSrcS(genChunk(sl))));
        check('s154b.roundTrip.status', pr.parseStatus === 'parsed', `${pr.parseStatus}: ${pr.parseNote}`);
        check('s154b.roundTrip.folders', J(pr.includeFilters) === J(uniq(folders.map(collapse))) && J(pr.excludeFilters) === J(uniq(folders.map(collapse))), J(pr.includeFilters).slice(0, 300));
        check('s154b.roundTrip.sources', J(pr.includeSources) === J(uniq(sources.map(collapse))) && J(pr.excludeSources) === J(uniq(sources.map(collapse))), J(pr.excludeSources).slice(0, 300));

        // --- semantics: the recovered pattern matches what the REGEX matches.
        // JS has no atomic groups; (?>X) is emulated as (?=(X))\N, which
        // never backtracks into X (the test below shows it does not).
        const compileFrag = (frag: string): RegExp => {
            let out = '';
            let n = 0;
            let i = 0;
            while (i < frag.length) {
                if (frag.slice(i, i + 3) === '(?>') {
                    const close = frag.indexOf(')', i);
                    n += 1;
                    out += '(?=(' + frag.slice(i + 3, close) + '))' + BS + String(n);
                    i = close + 1;
                } else {
                    out += frag.charAt(i);
                    i += 1;
                }
            }
            return new RegExp('^' + out + '$');
        };
        check('s154b.sem.emulationIsAtomic', compileFrag(A + 'a)b').test('xaab') === false && mod.fnmatchLite('xaab', '*ab') === true && compileFrag(A + 'a)' + S + 'b').test('xaab') === true);
        const VAL = 'abcxyzA0_/.:+@~-';
        const instance = (p: string): string => {
            let v = '';
            for (const ch of p) {
                if (ch === '*') v += word(VAL, 0, 4);
                else if (ch === '?') v += VAL.charAt(rnd(VAL.length));
                else v += ch;
            }
            return v;
        };
        const mutateV = (v: string): string => {
            if (v.length === 0) return word(VAL, 1, 3);
            const at = rnd(v.length);
            const r = rnd(3);
            if (r === 0) return v.slice(0, at) + v.slice(at + 1);
            if (r === 1) return v.slice(0, at) + VAL.charAt(rnd(VAL.length)) + v.slice(at);
            return v.slice(0, at) + VAL.charAt(rnd(VAL.length)) + v.slice(at + 1);
        };
        let semPairs = 0;
        let semHits = 0;
        let semBad = 0;
        let semFirstBad = '';
        const SEM_PATTERNS = GOLD_5B.map(([, pat]) => pat).concat(['*a*a*b', '*a*a*a*a*a*a*b', '/var/log/********x', '*/*/*/*/*/*.x', '?s', '*a*b', '/var/log/*a*a*a*']);
        for (let k = 0; k < 150; k += 1) {
            let s = word(SRCA, 1, 14);
            if (!/[^*?/]/.test(s)) s += 'x';
            SEM_PATTERNS.push(s);
        }
        for (const pat of SEM_PATTERNS) {
            // the pattern as the Data Doctor reads it back from the generated text
            const back = P(blk(excSrcS(genChunk([genSourceL(pat)])))).excludeSources;
            const rxP = compileFrag(genFragL(pat));
            const semCase = (v: string): void => {
                const rx = rxP.test(v);
                const glob = mod.fnmatchLite(v, pat);
                const rec = back.length === 1 && mod.fnmatchLite(v, back[0]);
                semPairs += 1;
                if (rx) semHits += 1;
                if (rx !== glob || rx !== rec) {
                    semBad += 1;
                    if (!semFirstBad) semFirstBad = `${pat} | ${v} | rx=${rx} glob=${glob} recovered=${J(back)}:${rec}`;
                }
            };
            for (let k = 0; k < 12; k += 1) {
                const v = instance(pat);
                semCase(v);
                semCase(mutateV(v));
                semCase(word(VAL, 0, 12));
            }
        }
        check('s154b.sem.agree', semBad === 0 && semHits > 500 && semPairs - semHits > 500, `${semBad} of ${semPairs} disagree (hits ${semHits}); first: ${semFirstBad}`);
        // the limit-breaking shapes of §5b on long values (no glob oracle here:
        // fnmatchLite's '.*' per '*' is the very backtracking §5b removes)
        check(
            's154b.sem.longValues',
            compileFrag(genFragL('*a*a*a*a*a*a*b')).test('/' + 'a'.repeat(150)) === false &&
                compileFrag(genFragL('*a*a*a*a*a*a*b')).test('/' + 'a'.repeat(150) + 'b') === true &&
                compileFrag(genFragL('/var/log/********x')).test('/var/log/' + 'y'.repeat(80)) === false &&
                compileFrag(genFragL('/var/log/********x')).test('/var/log/' + 'y'.repeat(80) + 'x') === true &&
                compileFrag(genFragL('*/*/*/*/*/*/*/*.x')).test('/a'.repeat(17)) === false &&
                compileFrag(genFragL('*/*/*/*/*/*/*/*.x')).test('/a'.repeat(17) + '.x') === true,
        );
    }

    // --- settings shapes carry the two new keys ------------------------------
    {
        const SC2 = SC.replace('days_in_past = 7', 'days_in_past = 7\ninclude_sources = linux/linux_secure=/var/log/sssd/*, ps\nexclude_sources = /var/log/zypper.log, /var/log/YaST2/*');
        const ps2 = P(SC2);
        check('s154.sc.parsed', ps2.parseStatus === 'parsed' && ps2.inputShape === 'settings-conf', ps2.parseStatus);
        check('s154.sc.includeSources', J(ps2.includeSources) === J(['linux/linux_secure=/var/log/sssd/*', 'ps']), J(ps2.includeSources));
        check('s154.sc.excludeSources', J(ps2.excludeSources) === J(['/var/log/zypper.log', '/var/log/YaST2/*']), J(ps2.excludeSources));
        check('s154.sc.crlf', J(P(SC2.split('\n').join('\r\n')).excludeSources) === J(ps2.excludeSources));
        // an older Data TA (no source keys) still parses fully
        const psOld = P(SC);
        check('s154.sc.oldTaParsed', psOld.parseStatus === 'parsed' && psOld.includeSources.length === 0 && psOld.excludeSources.length === 0);
        // the source keys never stand in for a missing core key
        const psSrcOnly = P('[filter_settings]\nfilter_enabled = 1\ndays_in_past = 7\ninclude_sources = ps\nexclude_sources = who');
        check('s154.sc.sourceKeysNotCore', psSrcOnly.parseStatus === 'partial' && J(psSrcOnly.excludeSources) === J(['who']), psSrcOnly.parseStatus);
        // REST JSON + XML
        const TWO2 = JSON.stringify({
            entry: [
                { name: 'cloud_provider_settings', content: { cloud_provider: 'aws' } },
                { name: 'filter_settings', content: { filter_enabled: '1', include_filters: 'hana/*', exclude_filters: '', days_in_past: '30', include_sources: '/usr/sap/*/trace/*', exclude_sources: '/var/log/zypper.log' } },
            ],
        });
        const pj2 = P(TWO2);
        check('s154.json.sources', pj2.parseStatus === 'parsed' && J(pj2.includeSources) === J(['/usr/sap/*/trace/*']) && J(pj2.excludeSources) === J(['/var/log/zypper.log']), J(pj2));
        check('s154.json.oldTa', P(TWO).includeSources.length === 0 && P(TWO).parseStatus === 'parsed');
        const BARE2 = JSON.stringify({ exclude_sources: '/var/log/zypper.log' });
        const pBare = P(BARE2);
        check('s154.json.bareSourceOnly', pBare.inputShape === 'rest-json' && pBare.parseStatus === 'partial' && J(pBare.excludeSources) === J(['/var/log/zypper.log']), `${pBare.inputShape}/${pBare.parseStatus}`);
        const XML2 = XML.replace('<s:key name="include_filters">*/*</s:key>', '<s:key name="include_filters">*/*</s:key>\n<s:key name="exclude_sources">/var/log/zypper.log,/var/log/YaST2/*</s:key>\n<s:key name="include_sources"></s:key>');
        const px2 = P(XML2);
        check('s154.xml.sources', px2.parseStatus === 'parsed' && J(px2.excludeSources) === J(['/var/log/zypper.log', '/var/log/YaST2/*']) && px2.includeSources.length === 0, J(px2));
    }

    // --- the KV row: writer, legacy rows, hostile rows -----------------------
    {
        const fS = facts({ includeFilters: ['hana/*'], includeSources: ['/usr/sap/*/trace/*'], excludeSources: ['/var/log/zypper.log', 'sap/saprouter=/var/log/messages'] });
        const recS = mod.factsToRecord(fS, '377');
        check('s154.kv.writes', recS.include_sources_json === J(['/usr/sap/*/trace/*']) && recS.exclude_sources_json === J(['/var/log/zypper.log', 'sap/saprouter=/var/log/messages']), J(recS));
        const rtS = mod.looksLikeIngestFacts(recS, NOW);
        check('s154.kv.roundTrip', rtS !== null && J(rtS.includeSources) === J(fS.includeSources) && J(rtS.excludeSources) === J(fS.excludeSources) && rtS.filtersApproximate === false);
        // a fixture/older caller without the fields writes empty lists
        const legacyFx = facts({});
        delete (legacyFx as Record<string, unknown>).includeSources;
        delete (legacyFx as Record<string, unknown>).excludeSources;
        const recL = mod.factsToRecord(legacyFx, '376');
        check('s154.kv.legacyFactsWriteEmpty', recL.include_sources_json === '[]' && recL.exclude_sources_json === '[]', J(recL));
        // a row written before session 154 (no fields at all) still validates
        const oldRow = Object.assign({}, recS);
        delete (oldRow as Record<string, unknown>).include_sources_json;
        delete (oldRow as Record<string, unknown>).exclude_sources_json;
        const rtOld = mod.looksLikeIngestFacts(oldRow, NOW);
        check('s154.kv.oldRowValid', rtOld !== null && rtOld.includeSources.length === 0 && rtOld.excludeSources.length === 0 && rtOld.filtersApproximate === false);
        check('s154.kv.emptyStringNotApprox', mod.looksLikeIngestFacts(Object.assign({}, recS, { exclude_sources_json: '' }), NOW).filtersApproximate === false);
        // hostile values: never trusted, never silent
        const hostile = (label: string, v: unknown, wantList: string[]): void => {
            const rt = mod.looksLikeIngestFacts(Object.assign({}, recS, { exclude_sources_json: v }), NOW);
            check(`s154.kv.hostile.${label}`, rt !== null && J(rt.excludeSources) === J(wantList) && rt.filtersApproximate === true, rt ? `${J(rt.excludeSources)} approx=${rt.filtersApproximate}` : 'null');
        };
        hostile('notJson', 'not json at all', []);
        hostile('object', J({ a: 1 }), []);
        hostile('number', 5, []);
        hostile('array', ['/var/log/x'], []);
        hostile(
            'badEntries',
            J(['/var/log/ok', 'a"b', 'a' + BS + 'b', 'a b', '*', '*/*', '/*', '?', 'x'.repeat(600), 'd=s', 'a/b/c=x', 'a/b=', '=x', '', 7, null, 'line\nbreak', 'caf' + String.fromCharCode(233), 'sap/saprouter=/var/log/messages']),
            ['/var/log/ok', 'sap/saprouter=/var/log/messages'],
        );
        hostile('tooMany', J(Array.from({ length: 300 }, (_x, i) => `/var/log/f${i}`)), Array.from({ length: mod.INGEST_MAX_SOURCE_PATTERNS }, (_x, i) => `/var/log/f${i}`));
        // over INGEST_MAX_LIST_JSON_CHARS of VALID entries: not even parsed
        // (without the size guard the first 256 would be read)
        hostile('hugeJson', J(Array.from({ length: 20000 }, (_x, i) => `/var/log/f${i}`)), []);
        const rtNull = mod.looksLikeIngestFacts(Object.assign({}, recS, { include_sources_json: null }), NOW);
        check('s154.kv.nullIsAbsent', rtNull !== null && rtNull.includeSources.length === 0 && rtNull.filtersApproximate === false);
        // the folder lists gained the same raw-size cap
        const rtHugeFolder = mod.looksLikeIngestFacts(Object.assign({}, recS, { include_filters_json: J(Array.from({ length: 40000 }, (_x, i) => `a${i}/b`)) }), NOW);
        check('s154.kv.hugeFolderJsonClamped', rtHugeFolder !== null && rtHugeFolder.includeFilters.length === 0 && rtHugeFolder.filtersApproximate === true);
        // and the reader still rejects off-shape rows outright
        check('s154.kv.badShapeStillNull', mod.looksLikeIngestFacts(Object.assign({}, recS, { parse_status: 'evil' }), NOW) === null);
    }

    // --- the entry grammar (read clamp and inverse share it) -----------------
    {
        const ok = ['/var/log/zypper.log', '/var/log/YaST2/*', 'ps', 'lastlog', 'WinEventLog:Security', 'Unix:ListeningPorts', '/usr/sap/*/trace/*', 'linux/linux_secure=/var/log/sssd/*', 'sap/saprouter=/var/log/messages', '*/*=/x', 'a?', '/var/log/a+b@c~d', 'x'.repeat(512), 'a'.repeat(1500) + '/b=/x'];
        const no = ['', '*', '**', '/*', '*/*', '?', '/', 'a b', 'a"b', 'a,b', 'a[b]', 'a' + BS + 'b', 'x'.repeat(513), 'dir=x', 'a/b/c=x', 'a/=x', '/b=x', 'a/b=', 'a/b=*', 'a/b=c=d', 'caf' + String.fromCharCode(233), 'a'.repeat(4090) + '/b=/xyz'];
        check('s154.grammar.accepts', ok.every((e) => mod.sourceEntryOk(e) === true), J(ok.filter((e) => !mod.sourceEntryOk(e))));
        check('s154.grammar.rejects', no.every((e) => mod.sourceEntryOk(e) === false), J(no.filter((e) => mod.sourceEntryOk(e))));
        check('s154.grammar.split', J(mod.splitSourceEntry('a/b=c/d')) === J({ folder: 'a/b', src: 'c/d' }) && J(mod.splitSourceEntry('/x')) === J({ folder: null, src: '/x' }));
    }

    // --- evaluator: pass-all (fix 4d), source rules, caps, wording ----------
    {
        check('s154.passAll.starStarMixed', mod.isPassAllInclude(['linux/cron', '*/*']) === true);
        check('s154.passAll.bareStarMixed', mod.isPassAllInclude(['linux/cron', '*']) === true);
        check('s154.passAll.starRunSegments', mod.isPassAllInclude(['**/*', 'linux/cron']) === true);
        // exactly the generator's test: `**` alone is not a valid pattern
        // (the Data TA refuses it), so it is not pass-all here either
        check('s154.passAll.bareStarRunNot', mod.isPassAllInclude(['**', 'linux/cron']) === false);
        check('s154.passAll.threeSegmentsNot', mod.isPassAllInclude(['*/*/*', 'linux/cron']) === false);
        check('s154.passAll.narrow', mod.isPassAllInclude(['linux/cron']) === false);
        check('s154.passAll.slashlessInertStill', mod.isPassAllInclude(['foo', 'linux/cron']) === false);
        check('s154.passAll.empty', mod.isPassAllInclude([]) === true);
        check('s154.passAll.halfStarNot', mod.isPassAllInclude(['*/cron']) === false);
        // integrator (session 154): ? is exactly one character, as the generator's [^"] (not zero or one)
        check('s154.glob.qmarkExactlyOne', mod.fnmatchLite('linux', 'l?nux') === true && mod.fnmatchLite('lnux', 'l?nux') === false && mod.fnmatchLite('liinux', 'l?nux') === false && mod.clzPathSurvives('lnux/cron', facts({ includeFilters: ['l?nux/cron'] })) === false);

        const gate = (over: Record<string, unknown> = {}): any => facts(Object.assign({ includeFilters: ['hana/*'] }, over));
        check('s154.rules.none', mod.hasSourceRules(facts({})) === false);
        check('s154.rules.exclude', mod.hasSourceRules(facts({ excludeSources: ['/var/log/zypper.log'] })) === true);
        check('s154.rules.includeBehindGate', mod.hasSourceRules(gate({ includeSources: ['ps'] })) === true);
        check('s154.rules.includeUnderPassAllInert', mod.hasSourceRules(facts({ includeFilters: ['*/*'], includeSources: ['ps'] })) === false);
        // integrator (session 154): filtering reported OFF = no rule in effect (the Data TA generates nothing,
        // the S3 Direct preview shows no note); unknown stays conservative
        check('s154.rules.disabledInert', mod.hasSourceRules(gate({ includeSources: ['ps'], excludeSources: ['/var/log/zypper.log'], filterEnabled: false })) === false && mod.sourceRulesLine(facts({ excludeSources: ['ps'], filterEnabled: false })) === null && mod.folderVerdictCap(facts({ excludeSources: ['ps'], filterEnabled: false }), NOW) === 'confirmed');
        check('s154.rules.unknownConservative', mod.hasSourceRules(facts({ excludeSources: ['ps'], filterEnabled: null })) === true);
        const noFields = facts({});
        delete (noFields as Record<string, unknown>).includeSources;
        delete (noFields as Record<string, unknown>).excludeSources;
        check('s154.rules.undefinedSafe', mod.hasSourceRules(noFields) === false && mod.includeSourcesOf(noFields).length === 0 && mod.excludeSourcesOf(null).length === 0);

        // includeSourcesMayKeep: which dropped folders could a rule rescue?
        check('s154.keep.plainReachesAny', mod.includeSourcesMayKeep(['linux/messages'], gate({ includeSources: ['/var/log/messages'] })) === true);
        check('s154.keep.scopedOwnFolder', mod.includeSourcesMayKeep(['linux/linux_secure'], gate({ includeSources: ['linux/linux_secure=/var/log/sssd/*'] })) === true);
        check('s154.keep.scopedOtherFolder', mod.includeSourcesMayKeep(['linux/cron'], gate({ includeSources: ['linux/linux_secure=/var/log/sssd/*'] })) === false);
        check('s154.keep.scopedWildFolder', mod.includeSourcesMayKeep(['linux/cron'], gate({ includeSources: ['linux/*=/var/log/x'] })) === true);
        check('s154.keep.includedNothingToRescue', mod.includeSourcesMayKeep(['hana/hanaaudit'], gate({ includeSources: ['ps'] })) === false);
        check('s154.keep.folderExcludeWins', mod.includeSourcesMayKeep(['linux/messages'], gate({ includeSources: ['ps'], excludeFilters: ['linux/messages'] })) === false);
        check('s154.keep.disabled', mod.includeSourcesMayKeep(['linux/messages'], gate({ includeSources: ['ps'], filterEnabled: false })) === false);
        check('s154.keep.passAll', mod.includeSourcesMayKeep(['linux/messages'], facts({ includeSources: ['ps'] })) === false);

        // statuses stay folder-based; the cap carries the approximation
        check('s154.status.excludeSourcesKeepFolder', mod.typeDropStatus('linux_secure', facts({ excludeSources: ['linux/linux_secure=/var/log/zypper.log'] })) === 'kept');
        check('s154.status.includeSourcesFolderDropped', mod.typeDropStatus('linux:cron', gate({ includeSources: ['ps'] })) === 'dropped');
        check('s154.cap.sourcesLikely', mod.folderVerdictCap(facts({ excludeSources: ['ps'] }), NOW) === 'likely');
        check('s154.cap.noSourcesConfirmed', mod.folderVerdictCap(facts({}), NOW) === 'confirmed');
        check('s154.cap.partialStaysPossible', mod.folderVerdictCap(facts({ excludeSources: ['ps'], parseStatus: 'partial' }), NOW) === 'possible');
        check('s154.cap.plainCapUnchanged', mod.suppliedConfidenceCap(facts({ excludeSources: ['ps'] }), NOW) === 'confirmed');

        // the defaults fingerprint needs empty source lists
        const dfl = facts({ filterEnabled: false, daysInPast: 7, includeFilters: ['*/*'], excludeFilters: [] });
        check('s154.defaults.stillDefaults', mod.isDefaultsShape(dfl) === true);
        check('s154.defaults.sourcesNotDefaults', mod.isDefaultsShape(Object.assign({}, dfl, { excludeSources: ['ps'] })) === false);
        const dflNoFields = Object.assign({}, dfl);
        delete (dflNoFields as Record<string, unknown>).includeSources;
        check('s154.defaults.undefinedSafe', mod.isDefaultsShape(dflNoFields) === true);

        // wording
        const sumS = mod.ingestFactsSummary(gate({ includeSources: ['/usr/sap/*/trace/*'], excludeSources: ['/var/log/zypper.log'] }));
        check('s154.summary.lists', sumS.indexOf('include sources: /usr/sap/*/trace/*') !== -1 && sumS.indexOf('exclude sources: /var/log/zypper.log') !== -1, sumS);
        check('s154.summary.note', sumS.indexOf(mod.SOURCE_RULES_NOTE) !== -1, sumS);
        const sumPA = mod.ingestFactsSummary(facts({ includeFilters: ['*/*'], includeSources: ['ps'] }));
        check('s154.summary.passAllNoEffect', sumPA.indexOf('(no effect') !== -1 && sumPA.indexOf(mod.SOURCE_RULES_NOTE) === -1, sumPA);
        const sumNone = mod.ingestFactsSummary(facts({ includeFilters: ['linux/*'] }));
        check('s154.summary.unchangedWithout', sumNone.indexOf('sources') === -1, sumNone);
        check('s154.summary.legacyFixture', mod.ingestFactsSummary(noFields).indexOf('sources') === -1);
        check('s154.line.null', mod.sourceRulesLine(facts({})) === null);
        const ln = mod.sourceRulesLine(facts({ excludeSources: ['/var/log/zypper.log'] }));
        check('s154.line.text', typeof ln === 'string' && ln.indexOf('exclude sources: /var/log/zypper.log') !== -1 && ln.indexOf('approximate') !== -1, String(ln));
        const many = Array.from({ length: 14 }, (_x, i) => `/f${i}`);
        check('s154.display.truncates', mod.patternListForDisplay(many) === many.slice(0, 10).join(', ') + ', … (+4 more)', mod.patternListForDisplay(many));
    }

    // --- the page's save path: raw structure, scrubbed storage (review) -----
    {
        const prep = (t: string): any => mod.prepareIngestPaste(t, NOW);
        // legal values the scrubber's flag / key=value rules fire on
        const TRAP_EXC = ['/var/log/unattended-upgrades/*', '/var/log/YaST2/y2log-UPD*', 'linux/sshkey=/var/log/x', 'token:abc', 'Unix:ListeningPorts'];
        const TRAP_INC = ['/usr/sap/sap-utils/*', 'linux/messages=/var/log/x-user.log'];
        check('s154.page.trapsAreLegal', TRAP_EXC.concat(TRAP_INC).every((e) => mod.sourceEntryOk(e) === true));
        const tcT = blk(DROP, allowS(G_HANA_STAR), incSrcS(genChunk(TRAP_INC.map(genSource))), excSrcS(genChunk(TRAP_EXC.map(genSource))));
        const scT = '[filter_settings]\nfilter_enabled = 1\ninclude_filters = hana/*\nexclude_filters =\ninclude_sources = ' + TRAP_INC.join(', ') + '\nexclude_sources = ' + TRAP_EXC.join(', ') + '\ndays_in_past = 7\n';
        const rjT = JSON.stringify(
            {
                origin: 'https://ds-01:8089/servicesNS/nobody/splunk_ta_sap_logserv/splunk_ta_sap_logserv_settings',
                entry: [{ name: 'filter_settings', id: 'https://ds-01:8089/x', content: { filter_enabled: '1', include_filters: 'hana/*', exclude_filters: '', include_sources: TRAP_INC.join(','), exclude_sources: TRAP_EXC.join(','), days_in_past: '7', 'eai:acl': null } }],
            },
            null,
            2,
        );
        const xmT = XML.replace('<s:key name="include_filters">*/*</s:key>', '<s:key name="include_filters">hana/*</s:key>\n<s:key name="include_sources">' + TRAP_INC.join(',') + '</s:key>\n<s:key name="exclude_sources">' + TRAP_EXC.join(',') + '</s:key>');
        for (const [label, text, shape] of [['transforms', tcT, 'transforms-conf'], ['settings', scT, 'settings-conf'], ['restJson', rjT, 'rest-json'], ['restXml', xmT, 'rest-xml']]) {
            // control: scrubbing first really does break this paste (the hazard)
            const viaScrub = P(mod.scrubPaste(text));
            check(`s154.page.${label}.hazardControl`, viaScrub.parseStatus !== 'parsed' || J(viaScrub.excludeSources) !== J(TRAP_EXC) || J(viaScrub.includeSources) !== J(TRAP_INC), J(viaScrub).slice(0, 300));
            const pg = prep(text);
            check(
                `s154.page.${label}.parsed`,
                pg.parsed.parseStatus === 'parsed' && pg.parsed.inputShape === shape && J(pg.parsed.excludeSources) === J(TRAP_EXC) && J(pg.parsed.includeSources) === J(TRAP_INC) && J(pg.parsed.includeFilters) === J(['hana/*']),
                J(pg.parsed).slice(0, 400),
            );
            check(`s154.page.${label}.scrubbedStored`, pg.scrubbed === mod.scrubPaste(text));
        }
        check('s154.page.restHost', prep(rjT).parsed.sourceHost === 'ds-01', prep(rjT).parsed.sourceHost);
        // clean pastes: the page path reads exactly what the parser reads
        for (const [label, text] of [['full', FULL], ['old', TC], ['settings', SC], ['json', TWO], ['xml', XML], ['goldenSaprouter', blk(excSrcS(G_SAPROUTER))], ['goldenYast2', blk(excSrcS(G_YAST2))], ['goldenLinuxSecure', blk(DROP, allowS(G_LINUX_SECURE))]]) {
            check(`s154.page.clean.${label}`, J(prep(text).parsed) === J(P(text)), label);
        }
        // secrets: the stored text AND every parsed field stay scrubbed
        // the fake access-key id is built at run time: the release credential sweep greps the source tree
        // for that literal shape (CLAUDE.md mandate 11), and a test fixture must not trip it
        const FAKE_AKID = 'AKIA' + 'ABCDEFGHIJKLMNOP';
        const SECRET =
            'curl -k -u admin:Sup3rSecret "https://ds-01:8089/x?output_mode=json"\n' +
            scT.replace('include_filters = hana/*', 'include_filters = hana/*, password=Hunter2').replace('exclude_sources = ', 'exclude_sources = ' + FAKE_AKID + ', http://u:Pw9x@h/x, ');
        const ps = prep(SECRET);
        for (const secret of ['Sup3rSecret', 'Hunter2', 'ABCDEFGHIJKLMNOP', 'Pw9x']) {
            check(`s154.page.secret.${secret}`, ps.scrubbed.indexOf(secret) === -1 && J(ps.parsed).indexOf(secret) === -1, J(ps.parsed).slice(0, 300));
        }
        check('s154.page.secret.legalKept', J(ps.parsed.excludeSources.slice(2)) === J(TRAP_EXC) && J(ps.parsed.includeSources) === J(TRAP_INC), J(ps.parsed.excludeSources));
        // a free-text stanza header never carries its text into the note
        const pn = prep(blk(DROP, allowS(G_HANA_STAR), '[logserv_filter_x password=Hunter2]\nREGEX = .\n'));
        check('s154.page.headerNote', pn.parsed.parseStatus === 'partial' && pn.parsed.parseNote.indexOf('[logserv_filter_x…]') !== -1 && pn.parsed.parseNote.indexOf('Hunter2') === -1, pn.parsed.parseNote);
        // the host string goes through the full scrubber too
        const pHost = prep(rjT.split('https://ds-01:8089/x').join('https://' + FAKE_AKID + '@ds-01:8089/x'));
        check('s154.page.hostScrubbed', pHost.parsed.sourceHost.indexOf('ABCDEFGHIJKLMNOP') === -1 && pHost.parsed.parseStatus === 'parsed', pHost.parsed.sourceHost);
        // the over-cap paste: stored truncated, parsed from the same capped text
        const pBig = prep('x'.repeat(mod.MAX_INGEST_PASTE_CHARS + 500));
        check('s154.page.cap', pBig.parsed.parseStatus === 'unparsed' && pBig.scrubbed.indexOf('[truncated') !== -1);
        const pPast = prep('#'.repeat(mod.MAX_INGEST_PASTE_CHARS) + '\n' + SC);
        check('s154.page.capParsesCapped', pPast.parsed.parseStatus === 'unparsed' && P('#'.repeat(mod.MAX_INGEST_PASTE_CHARS) + '\n' + SC).parseStatus === 'parsed', pPast.parsed.parseStatus);
    }

    // --- stanza headers of any shape; cut-off pastes (review) ----------------
    {
        const c1 = genChunk([genFolder('linux/cron')]);
        const c2 = genChunk([genFolder('proxy/squid')]);
        const pDash = P(blk(excS(c1), stz('logserv_filter_exclude-2', c2)));
        check('s154.header.dashChunkUnknown', pDash.parseStatus === 'partial' && pDash.parseNote.indexOf('[logserv_filter_exclude-2]') !== -1 && J(pDash.excludeFilters) === J(['linux/cron']), `${pDash.parseStatus} ${pDash.parseNote}`);
        const pSpace = P(blk(excS(c1), stz('logserv_filter_exclude 2', c2)));
        check('s154.header.spaceChunkUnknown', pSpace.parseStatus === 'partial' && /Unrecognized/.test(pSpace.parseNote), pSpace.parseNote);
        // a header that never closes yields no stanza name at all: never a
        // whole (pass-all) block, even inside a complete marker pair
        const pUnclosed = P(blk('[logserv_filter_exclude\nREGEX = ' + c1 + '\n'));
        check('s154.header.unclosedPartial', pUnclosed.parseStatus === 'partial' && pUnclosed.filterEnabled === true, `${pUnclosed.parseStatus} ${pUnclosed.parseNote}`);
        // a source-only paste cut at the bottom carries both notes
        const pHalfSrc = P(MSTART + '\n' + excSrcS(G_ZYPPER));
        check('s154.cut.halfSourceOnlyNotes', /only source-rule stanzas/.test(pHalfSrc.parseNote) && /cut off/.test(pHalfSrc.parseNote), pHalfSrc.parseNote);
        const full = blk(DROP, allowS(G_HANA_STAR), excS(G_LINUX_SECURE), excSrcS(G_ZYPPER));
        const pWhole = P(full);
        check('s154.cut.wholeParsed', pWhole.parseStatus === 'parsed' && J(pWhole.excludeSources) === J(['/var/log/zypper.log']), pWhole.parseStatus);
        const pBottom = P(full.slice(0, full.indexOf('[logserv_filter_exclude_sources]')));
        check('s154.cut.bottomPartial', pBottom.parseStatus === 'partial' && /cut off/.test(pBottom.parseNote) && pBottom.excludeSources.length === 0, `${pBottom.parseStatus} ${pBottom.parseNote}`);
        const pTop = P(full.slice(full.indexOf('[logserv_filter_exclude]')));
        check('s154.cut.topPartial', pTop.parseStatus === 'partial' && /cut off/.test(pTop.parseNote), `${pTop.parseStatus} ${pTop.parseNote}`);
        // no markers at all keeps today's fragment reading (parsed)
        check('s154.cut.noMarkersUnchanged', P(excS(G_HANA_STAR)).parseStatus === 'parsed');
    }

    // --- check 29 in the cascade (the verdict consumer) ----------------------
    {
        const cascade = require('./diagCascade') as any;
        const RNOW = Math.floor(Date.now() / 1000);
        const RAWHANA = '`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count';
        const pf = {
            spl: RAWHANA,
            earliest: '-30d@d',
            latest: 'now',
            dispatched: true,
            loading: false,
            errorMessage: null,
            rowCount: 0,
            cloudProvider: 'all',
        };
        const fx = (over: Record<string, unknown> = {}): any => facts(Object.assign({ suppliedAt: RNOW - 100, daysInPast: 7 }, over));
        const ev = (fxo: any, over: Record<string, unknown> = {}): any =>
            Object.assign(
                {
                    indexRowsInWindow: 5000,
                    resolvedIndexes: null,
                    macroIndexes: null,
                    visibleIndexes: null,
                    sourcetypeCounts: { linux_messages_syslog: 5000 },
                    sourcetypeLastSeen: { 'sap:hana:audit': RNOW - 30 * 86400 },
                    sourcetypeRecentSeen: null,
                    preCutoffOldest: null,
                    fallbackRowsInWindow: null,
                    routedRowsInWindow: null,
                    sourceScope: null,
                    producerDisabled: null,
                    producerTracedCount: null,
                    collectionRowsInWindow: null,
                    collectionRowsAllMetrics: null,
                    collectionExtentProbed: false,
                    collectionOldest: null,
                    collectionNewest: null,
                    installedApps: null,
                    kvStoreStatus: null,
                    ingestFacts: fxo,
                    canaryMs: null,
                    notes: [],
                    budgetExhausted: false,
                },
                over,
            );
        const ids = (d: any): string[] => d.all.map((v: any) => v.id);
        const dCtl = cascade.diagnosePanel(pf, ev(fx({ excludeFilters: ['hana/hanaaudit'] })));
        check('s154.c29.controlConfirmed', dCtl.top.id === 'ingest-type-excluded' && dCtl.top.confidence === 'confirmed', `${dCtl.top.id}/${dCtl.top.confidence}`);
        const dSrc = cascade.diagnosePanel(pf, ev(fx({ excludeFilters: ['hana/hanaaudit'], excludeSources: ['/var/log/zypper.log'] })));
        check('s154.c29.sourcesCapLikely', dSrc.top.id === 'ingest-type-excluded' && dSrc.top.confidence === 'likely', `${dSrc.top.id}/${dSrc.top.confidence}`);
        check('s154.c29.headlineNote', dSrc.top.headline.indexOf(mod.SOURCE_RULES_NOTE) !== -1, dSrc.top.headline);
        check('s154.c29.evidenceLine', dSrc.top.evidence.some((l: string) => l.indexOf('exclude sources: /var/log/zypper.log') !== -1), J(dSrc.top.evidence));
        check('s154.c29.controlHeadlineUnchanged', dCtl.top.headline.indexOf('source rules') === -1 && dCtl.top.headline.indexOf('approximate') === -1, dCtl.top.headline);
        // include gate drops hana; a plain include source may keep some of its
        // files, so hana events present in the window are NOT a contradiction
        const gateFx = (over: Record<string, unknown> = {}): any => fx(Object.assign({ includeFilters: ['linux/*'] }, over));
        const dPresent = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['/usr/sap/*/trace/*'] }), { sourcetypeCounts: { 'sap:hana:audit': 10 } }));
        check('s154.c29.presentExplained', ids(dPresent).indexOf('ingest-facts-contradicted') === -1 && ids(dPresent).indexOf('ingest-type-excluded') === -1, ids(dPresent).join(','));
        const dPresentCtl = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['linux/linux_secure=/var/log/sssd/*'] }), { sourcetypeCounts: { 'sap:hana:audit': 10 } }));
        check('s154.c29.presentScopedElsewhereContradicts', ids(dPresentCtl).indexOf('ingest-facts-contradicted') !== -1, ids(dPresentCtl).join(','));
        // newer events (by event time) than the paste: explained -> possible + line
        const dNewer = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['/usr/sap/*/trace/*'] }), { sourcetypeLastSeen: { 'sap:hana:audit': RNOW - 10 } }));
        const vNewer = dNewer.all.filter((v: any) => v.id === 'ingest-type-excluded')[0];
        check('s154.c29.newerExplainedPossible', ids(dNewer).indexOf('ingest-facts-contradicted') === -1 && !!vNewer && vNewer.confidence === 'possible', `${ids(dNewer).join(',')} ${vNewer ? vNewer.confidence : '-'}`);
        check('s154.c29.newerLine', !!vNewer && vNewer.evidence.some((l: string) => l.indexOf('include-source rules may keep') !== -1), vNewer ? J(vNewer.evidence) : '-');
        const dNewerCtl = cascade.diagnosePanel(pf, ev(gateFx({}), { sourcetypeLastSeen: { 'sap:hana:audit': RNOW - 10 } }));
        check('s154.c29.newerControlContradicts', ids(dNewerCtl).indexOf('ingest-facts-contradicted') !== -1, ids(dNewerCtl).join(','));
        // a legacy facts object without the source fields behaves as before
        const legacy = fx({ excludeFilters: ['hana/hanaaudit'] });
        delete legacy.includeSources;
        delete legacy.excludeSources;
        const dLegacy = cascade.diagnosePanel(pf, ev(legacy));
        check('s154.c29.legacyConfirmed', dLegacy.top.id === 'ingest-type-excluded' && dLegacy.top.confidence === 'confirmed', `${dLegacy.top.id}/${dLegacy.top.confidence}`);

        // Review — ZERO events of a unit the include gate drops but whose
        // files Include Sources may keep: never "fully dropped" (possible),
        // its paths named as dropped unless Include Sources keeps them.
        const vOf = (d: any): any => d.all.filter((v: any) => v.id === 'ingest-type-excluded')[0];
        const brief = (v: any, d: any): string => (v ? `${v.short}/${v.confidence}: ${v.headline}` : ids(d).join(','));
        const dZCtl = cascade.diagnosePanel(pf, ev(gateFx({})));
        const vZCtl = vOf(dZCtl);
        check('s154.c29.zeroControlExcluded', !!vZCtl && vZCtl.short === 'Excluded at ingest' && vZCtl.confidence === 'confirmed', brief(vZCtl, dZCtl));
        const dZPlain = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['/usr/sap/*/trace/*'] })));
        const vZPlain = vOf(dZPlain);
        check('s154.c29.zeroMayKeepPossible', !!vZPlain && vZPlain.short === 'Possibly excluded?' && vZPlain.confidence === 'possible' && vZPlain.headline.indexOf('may be dropped') !== -1 && vZPlain.headline.indexOf('hana/hanaaudit') !== -1, brief(vZPlain, dZPlain));
        check(
            's154.c29.zeroMayKeepEvidence',
            !!vZPlain && vZPlain.evidence[0].indexOf('(none for certain)') !== -1 && vZPlain.evidence.some((l: string) => l.indexOf('unless the Include Sources rules keep some of their files: hana/hanaaudit') !== -1),
            vZPlain ? J(vZPlain.evidence) : '-',
        );
        const dZOwn = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['hana/hanaaudit=/hana/log/*'] })));
        const vZOwn = vOf(dZOwn);
        check('s154.c29.zeroScopedOwnFolderPossible', !!vZOwn && vZOwn.short === 'Possibly excluded?' && vZOwn.confidence === 'possible', brief(vZOwn, dZOwn));
        // a rule scoped to ANOTHER folder keeps nothing here: still excluded
        // (at most likely, because a source rule is in effect)
        const dZElse = cascade.diagnosePanel(pf, ev(gateFx({ includeSources: ['linux/linux_secure=/var/log/sssd/*'] })));
        const vZElse = vOf(dZElse);
        check('s154.c29.zeroScopedElsewhereExcluded', !!vZElse && vZElse.short === 'Excluded at ingest' && vZElse.confidence === 'likely', brief(vZElse, dZElse));
        // a multi-folder type: the folders the rule may keep are listed apart
        const pfMsg = Object.assign({}, pf, { spl: '`sap_logserv_idx_macro` sourcetype="linux_messages_syslog" | stats count' });
        const evMsg = (fxo: any): any => ev(fxo, { sourcetypeCounts: { 'linux:cron': 5000 }, sourcetypeLastSeen: { linux_messages_syslog: RNOW - 30 * 86400 } });
        const cronGate = (over: Record<string, unknown> = {}): any => fx(Object.assign({ includeFilters: ['linux/cron'] }, over));
        const dMixCtl = cascade.diagnosePanel(pfMsg, evMsg(cronGate({})));
        check('s154.c29.mixedControlExcluded', !!vOf(dMixCtl) && vOf(dMixCtl).short === 'Excluded at ingest', brief(vOf(dMixCtl), dMixCtl));
        const dMix = cascade.diagnosePanel(pfMsg, evMsg(cronGate({ includeSources: ['linux/messages=/var/log/messages'] })));
        const vMix = vOf(dMix);
        check(
            's154.c29.mixedPartly',
            !!vMix && vMix.short === 'Partly excluded?' && vMix.confidence === 'possible' && vMix.headline.indexOf('linux/localmessages, linux/proxy') !== -1 && vMix.headline.indexOf('unless the Include Sources rules keep them: linux/messages.') !== -1,
            brief(vMix, dMix),
        );
        check('s154.c29.mixedEvidenceSplit', !!vMix && vMix.evidence[0].indexOf('linux/localmessages, linux/proxy') !== -1 && vMix.evidence[0].indexOf('linux/messages') === -1, vMix ? J(vMix.evidence) : '-');
    }

    // --- session 155 (design item j, U41): the no-folder route --------------
    // sap:hana:tracelogs can also arrive WITHOUT folder fields, routed by the
    // Data TA's un-annotated [set_srctype_hana_tracelogs_by_source]. Folder
    // filters never reach those events; check 29 must neither call them
    // contradicting nor claim more than 'possible' where they change a status.
    {
        const TR = 'sap:hana:tracelogs';
        const PAT = '/usr/sap/*/HDB??/*/trace/*';
        // the map and the line, pinned
        check('s155.nofolder.mapKeys', J(Object.keys(mod.SOURCETYPE_NOFOLDER_SOURCES)) === J([TR]), J(mod.SOURCETYPE_NOFOLDER_SOURCES));
        check('s155.nofolder.mapPattern', J(mod.SOURCETYPE_NOFOLDER_SOURCES[TR]) === J([PAT]));
        check('s155.nofolder.lineKeys', J(Object.keys(mod.NOFOLDER_LINES)) === J(Object.keys(mod.SOURCETYPE_NOFOLDER_SOURCES)) && mod.NOFOLDER_LINES[TR] === mod.NOFOLDER_LINE);
        check('s155.nofolder.typesRouted', Object.keys(mod.SOURCETYPE_NOFOLDER_SOURCES).every((st) => Object.prototype.hasOwnProperty.call(mod.SOURCETYPE_CLZ_MAP, st)));
        // each suggested entry is a legal Include Sources entry WITHOUT a folder
        // (a dir/subdir=pattern entry could never match these events)
        check(
            's155.nofolder.patternsLegalPlain',
            Object.keys(mod.SOURCETYPE_NOFOLDER_SOURCES).every((st) => mod.SOURCETYPE_NOFOLDER_SOURCES[st].every((p: string) => mod.sourceEntryOk(p) === true && mod.splitSourceEntry(p).folder === null)),
        );
        // the suggested entry keeps the paths the Data TA's route takes (its
        // value shapes: a .trc file or backup.log, tenant subfolder optional)
        const ROUTED = [
            '/usr/sap/BHJ/HDB02/vhbhjdb01/trace/nameserver_vhbhjdb01.30201.047.trc',
            '/usr/sap/BHJ/HDB02/vhbhjdb01/trace/backup.log',
            '/usr/sap/BHJ/HDB02/vhbhjdb01/trace/DB_BHZ/backup.log',
            '/usr/sap/XHQ/HDB04/vhxsdxhqdb01/trace/nameserver_alert_vhxsdxhqdb01.trc',
        ];
        check('s155.nofolder.patternKeepsRouted', ROUTED.every((p) => mod.fnmatchLite(p, PAT)), J(ROUTED.filter((p) => !mod.fnmatchLite(p, PAT))));
        check('s155.nofolder.lineNamesPattern', Object.keys(mod.NOFOLDER_LINES).every((st) => mod.SOURCETYPE_NOFOLDER_SOURCES[st].every((p: string) => mod.NOFOLDER_LINES[st].indexOf(p) !== -1)));
        check('s155.nofolder.lineNamesType', mod.NOFOLDER_LINE.indexOf('`' + TR + '`') === 0, mod.NOFOLDER_LINE);
        check('s155.nofolder.lineSays', /Exclude Filters never drop them/.test(mod.NOFOLDER_LINE) && /Exclude Sources can drop them/.test(mod.NOFOLDER_LINE) && /without a folder/.test(mod.NOFOLDER_LINE), mod.NOFOLDER_LINE);
        // no app version or build number in user-visible text
        check('s155.nofolder.lineNoVersion', !/\bv?\d+\.\d+\.\d+\b|\bbuild\b/i.test(mod.NOFOLDER_LINE), mod.NOFOLDER_LINE);

        // noFolderStatus — the generator's stages, folder-less
        const nf = (over: Record<string, unknown>, st = TR): string => mod.noFolderStatus(st, facts(over));
        check('s155.nofolder.status.unmappedNone', nf({ includeFilters: ['linux/*'] }, 'sap:hana:audit') === 'none' && nf({}, 'linux_secure') === 'none' && nf({}, 'constructor') === 'none' && nf({}, 'sap_logserv_logs') === 'none');
        check('s155.nofolder.status.disabledKept', nf({ includeFilters: ['linux/*'], filterEnabled: false }) === 'kept' && nf({ includeFilters: ['linux/*'], filterEnabled: null }) === 'kept');
        check('s155.nofolder.status.excludeFiltersNeverReach', nf({ excludeFilters: ['hana/tracelogs'] }) === 'kept' && nf({ excludeFilters: ['hana/*', '*/*'] }) === 'kept');
        check('s155.nofolder.status.scopedExcludeNeverMatches', nf({ excludeSources: ['hana/tracelogs=/usr/sap/*'] }) === 'kept');
        check('s155.nofolder.status.plainExcludeMay', nf({ excludeSources: ['/var/log/zypper.log'] }) === 'may');
        check('s155.nofolder.status.gateDrops', nf({ includeFilters: ['hana/*'] }) === 'dropped' && nf({ includeFilters: ['hana/tracelogs'] }) === 'dropped' && nf({ includeFilters: ['linux/*'] }) === 'dropped');
        check('s155.nofolder.status.scopedIncludeCannotKeep', nf({ includeFilters: ['linux/*'], includeSources: ['hana/tracelogs=/usr/sap/*'] }) === 'dropped');
        check('s155.nofolder.status.plainIncludeMay', nf({ includeFilters: ['hana/*'], includeSources: [PAT] }) === 'may' && nf({ includeFilters: ['hana/*'], includeSources: ['/var/log/zypper.log'] }) === 'may');
        check('s155.nofolder.status.passAllKept', nf({ includeFilters: ['*/*'] }) === 'kept' && nf({ includeFilters: ['linux/cron', '*'] }) === 'kept' && nf({ includeFilters: ['foo'] }) === 'kept' && nf({ includeFilters: ['*/*'], includeSources: [PAT] }) === 'kept');
        const nfLegacy = facts({ includeFilters: ['hana/*'] });
        delete (nfLegacy as Record<string, unknown>).includeSources;
        delete (nfLegacy as Record<string, unknown>).excludeSources;
        check('s155.nofolder.status.undefinedSafe', mod.noFolderStatus(TR, nfLegacy) === 'dropped');

        // check 29 in the cascade, on a HANA Trace panel
        const cascade = require('./diagCascade') as any;
        const RNOW = Math.floor(Date.now() / 1000);
        const pfOf = (spl: string): any => ({ spl, earliest: '-30d@d', latest: 'now', dispatched: true, loading: false, errorMessage: null, rowCount: 0, cloudProvider: 'all' });
        const pfT = pfOf('`sap_logserv_idx_macro` sourcetype="sap:hana:tracelogs" | stats count');
        const pfA = pfOf('`sap_logserv_idx_macro` sourcetype="sap:hana:audit" | stats count');
        const pfTA = pfOf('`sap_logserv_idx_macro` (sourcetype="sap:hana:tracelogs" OR sourcetype="sap:hana:audit") | stats count by sourcetype');
        const fx = (over: Record<string, unknown> = {}): any => facts(Object.assign({ suppliedAt: RNOW - 100, daysInPast: 7 }, over));
        const ev = (fxo: any, over: Record<string, unknown> = {}): any =>
            Object.assign(
                {
                    indexRowsInWindow: 5000,
                    resolvedIndexes: null,
                    macroIndexes: null,
                    visibleIndexes: null,
                    sourcetypeCounts: { linux_messages_syslog: 5000 },
                    sourcetypeLastSeen: { [TR]: RNOW - 30 * 86400, 'sap:hana:audit': RNOW - 30 * 86400 },
                    sourcetypeRecentSeen: null,
                    preCutoffOldest: null,
                    fallbackRowsInWindow: null,
                    routedRowsInWindow: null,
                    sourceScope: null,
                    producerDisabled: null,
                    producerTracedCount: null,
                    collectionRowsInWindow: null,
                    collectionRowsAllMetrics: null,
                    collectionExtentProbed: false,
                    collectionOldest: null,
                    collectionNewest: null,
                    installedApps: null,
                    kvStoreStatus: null,
                    ingestFacts: fxo,
                    canaryMs: null,
                    notes: [],
                    budgetExhausted: false,
                },
                over,
            );
        const ids = (d: any): string[] => d.all.map((v: any) => v.id);
        const vOf = (d: any): any => d.all.filter((v: any) => v.id === 'ingest-type-excluded')[0];
        const brief = (v: any, d: any): string => (v ? `${v.short}/${v.confidence}: ${v.headline}` : ids(d).join(','));
        const hasLine = (v: any): boolean => !!v && v.evidence.indexOf(mod.NOFOLDER_LINE) !== -1;
        const noContra = (d: any): boolean => ids(d).indexOf('ingest-facts-contradicted') === -1;
        const present = { sourcetypeCounts: { [TR]: 10 } };

        // (a) Exclude Filters hana/tracelogs with trace events present: the
        // folder-less files explain them — no contradiction, no verdict
        const dA = cascade.diagnosePanel(pfT, ev(fx({ excludeFilters: ['hana/tracelogs'] }), present));
        check('s155.nofolder.c29.presentExcludeNoContradiction', noContra(dA) && !vOf(dA), ids(dA).join(','));
        // ... also with a plain Exclude Sources entry (nf 'may')
        const dA2 = cascade.diagnosePanel(pfT, ev(fx({ excludeFilters: ['hana/tracelogs'], excludeSources: ['/var/log/zypper.log'] }), present));
        check('s155.nofolder.c29.presentMayNoContradiction', noContra(dA2) && !vOf(dA2), ids(dA2).join(','));
        // controls: an include gate with no plain Include Sources drops the
        // folder-less files too — present events still contradict; and the
        // audit type (no no-folder route) contradicts as before
        const dA3 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['linux/*'] }), present));
        check('s155.nofolder.c29.presentGateStillContradicts', !noContra(dA3), ids(dA3).join(','));
        const dA4 = cascade.diagnosePanel(pfA, ev(fx({ excludeFilters: ['hana/hanaaudit'] }), { sourcetypeCounts: { 'sap:hana:audit': 10 } }));
        check('s155.nofolder.c29.presentAuditStillContradicts', !noContra(dA4), ids(dA4).join(','));
        // newer events (event time) than the paste: explained, possible + line
        const dA5 = cascade.diagnosePanel(pfT, ev(fx({ excludeFilters: ['hana/tracelogs'] }), { sourcetypeLastSeen: { [TR]: RNOW - 10 } }));
        const vA5 = vOf(dA5);
        check('s155.nofolder.c29.newerExplained', noContra(dA5) && !!vA5 && vA5.confidence === 'possible', brief(vA5, dA5));
        check('s155.nofolder.c29.newerLine', !!vA5 && vA5.evidence.some((l: string) => l.indexOf('can arrive without folder fields, which the folder filters do not reach') !== -1), vA5 ? J(vA5.evidence) : '-');
        const dA6 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['linux/*'] }), { sourcetypeLastSeen: { [TR]: RNOW - 10 } }));
        check('s155.nofolder.c29.newerGateStillContradicts', !noContra(dA6), ids(dA6).join(','));

        // (b) the same exclusion with zero events: partial, never confirmed
        const dB = cascade.diagnosePanel(pfT, ev(fx({ excludeFilters: ['hana/tracelogs'] })));
        const vB = vOf(dB);
        check('s155.nofolder.c29.zeroExcludePartlyPossible', !!vB && vB.short === 'Partly excluded?' && vB.confidence === 'possible', brief(vB, dB));
        check('s155.nofolder.c29.zeroExcludeHeadline', !!vB && vB.headline.indexOf('configuration: hana/tracelogs.') !== -1 && vB.headline.indexOf('`sap:hana:tracelogs` events that arrive without folder fields are not reached by folder filters and may still be kept.') !== -1, brief(vB, dB));
        check('s155.nofolder.c29.zeroExcludeLine', hasLine(vB), vB ? J(vB.evidence) : '-');
        check('s155.nofolder.c29.zeroExcludeEvidence', !!vB && vB.evidence[0] === 'Dropped at ingest by the supplied filters: hana/tracelogs', vB ? vB.evidence[0] : '-');
        // a folder drop is the verdict itself (not a lead): it keeps the top
        // and the general detail
        check('s155.nofolder.c29.zeroExcludeStillTop', dB.top.id === 'ingest-type-excluded' && dB.top === vB, ids(dB).join(','));
        check('s155.nofolder.c29.zeroExcludeDetail', !!vB && vB.detail.indexOf('The other sources may simply have no events in this range.') === 0, vB ? vB.detail : '-');
        // no arrival history either: still possible, still partial
        const dB2 = cascade.diagnosePanel(pfT, ev(fx({ excludeFilters: ['hana/tracelogs'] }), { sourcetypeLastSeen: null }));
        check('s155.nofolder.c29.zeroExcludeNoHistoryPossible', !!vOf(dB2) && vOf(dB2).short === 'Partly excluded?' && vOf(dB2).confidence === 'possible', brief(vOf(dB2), dB2));

        // (c) Include hana/* and no source rules: the folders are kept, the
        // folder-less files are dropped — partial, named, with the fix
        const dC = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'] })));
        const vC = vOf(dC);
        check('s155.nofolder.c29.keptFolderPartly', !!vC && vC.short === 'Partly excluded?' && vC.confidence === 'possible', brief(vC, dC));
        check('s155.nofolder.c29.keptFolderHeadline', !!vC && vC.headline.indexOf('configuration: `sap:hana:tracelogs` events without folder fields.') !== -1 && vC.headline.indexOf('no Include Sources entry without a folder is supplied') !== -1, brief(vC, dC));
        check('s155.nofolder.c29.keptFolderEvidence', !!vC && vC.evidence[0] === 'Dropped at ingest by the supplied filters: `sap:hana:tracelogs` events without folder fields', vC ? vC.evidence[0] : '-');
        check('s155.nofolder.c29.keptFolderFix', !!vC && vC.detail.indexOf('an Include Sources entry such as ' + PAT + ' keeps the files that arrive without folder fields') !== -1, vC ? vC.detail : '-');
        check('s155.nofolder.c29.keptFolderLine', hasLine(vC), vC ? J(vC.evidence) : '-');
        // ... but only as a LEAD (review, U41): the verdict exists only
        // through the folder-less drop, so the observed verdict (here the
        // 30-day silence) keeps the top and the lead is listed after it
        check('s155.nofolder.c29.keptFolderLeadAfterTop', dC.top.id === 'sourcetype-stale' && dC.top.confidence === 'likely' && ids(dC).indexOf('ingest-type-excluded') > ids(dC).indexOf('sourcetype-stale'), ids(dC).join(','));
        check('s155.nofolder.c29.keptFolderLeadDetail', !!vC && vC.detail.indexOf('This matters only where SAP delivers some of these files without folder fields, which the supplied configuration does not show; the files that carry folder fields are kept.') === 0, vC ? vC.detail : '-');
        // Recipe 1's allow-list (every folder, hana/tracelogs among them) on a
        // fresh or wrong-index install: the confirmed "Never received" keeps
        // the top; the lead follows it, possible, with the line
        const R1 = ['abap/audit', 'abap/dispatcher', 'abap/enqueueserver', 'abap/event', 'abap/gateway', 'abap/icm', 'abap/messageserver', 'abap/sapstartsrv', 'abap/workprocess', 'dns/binddns', 'hana/hanaaudit', 'hana/tracelogs', 'linux/cron', 'linux/localmessages', 'linux/messages', 'linux/linux_secure', 'linux/pacemaker', 'linux/proxy', 'linux/slapd', 'linux/sudolog', 'linux/warn', 'proxy/squid', 'sap/saphostexec', 'sap/saprouter', 'sap/sapstartsrv', 'scc/audit', 'scc/tracelogs', 'webdispatcher/accesslog', 'windows/*'];
        const never = { sourcetypeLastSeen: {} };
        const dR1 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: R1 }), never));
        check('s155.nofolder.c29.recipe1NeverSeenTop', dR1.top.id === 'sourcetype-never-seen' && dR1.top.confidence === 'confirmed' && !hasLine(dR1.top), ids(dR1).join(','));
        check('s155.nofolder.c29.recipe1LeadAfter', !!vOf(dR1) && vOf(dR1).short === 'Partly excluded?' && vOf(dR1).confidence === 'possible' && hasLine(vOf(dR1)) && ids(dR1).indexOf('ingest-type-excluded') > ids(dR1).indexOf('sourcetype-never-seen'), brief(vOf(dR1), dR1));
        // with nothing else concluding (no arrival history, the index probe
        // failed) the lead is the top
        const dR2 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: R1 }), { sourcetypeLastSeen: null, indexRowsInWindow: null, sourcetypeCounts: { other: 5 } }));
        check('s155.nofolder.c29.leadTopWhenNothingConcludes', dR2.top.id === 'ingest-type-excluded' && dR2.top.short === 'Partly excluded?' && dR2.top.confidence === 'possible', ids(dR2).join(','));
        // ... while with the index probe answered, Gate 0's verdict stays on
        // top and the lead follows it
        const dR3 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: R1 }), { sourcetypeLastSeen: null, sourcetypeCounts: { other: 5 } }));
        check('s155.nofolder.c29.noHistoryLeadAfterGate0', dR3.top.id === 'gate0' && ids(dR3).indexOf('ingest-type-excluded') > ids(dR3).indexOf('gate0'), ids(dR3).join(','));
        // ... events present: the folder events are kept, nothing to say
        const dC2 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'] }), present));
        check('s155.nofolder.c29.keptFolderPresentSilent', noContra(dC2) && !vOf(dC2), ids(dC2).join(','));
        // ... newer events, by event time or by index time: the folders are
        // kept, so they contradict nothing and add no line
        const dC3 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'] }), { sourcetypeLastSeen: { [TR]: RNOW - 10 } }));
        check('s155.nofolder.c29.keptFolderNewerNoContradiction', noContra(dC3) && !!vOf(dC3) && !vOf(dC3).evidence.some((l: string) => /arrived after the configuration/.test(l)), ids(dC3).join(','));
        // (index time: supplied an hour ago, indexed now - past the skew grace)
        const recentNow = { sourcetypeRecentSeen: { [TR]: RNOW, 'sap:hana:audit': RNOW } };
        const dC4 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'], suppliedAt: RNOW - 3600 }), recentNow));
        check('s155.nofolder.c29.keptFolderRecentNoLine', !!vOf(dC4) && !vOf(dC4).evidence.some((l: string) => /recorded as indexed after/.test(l)), vOf(dC4) ? J(vOf(dC4).evidence) : ids(dC4).join(','));
        // control: the same index-time evidence on a dropped unit does add it
        const dC5 = cascade.diagnosePanel(pfA, ev(fx({ includeFilters: ['hana/tracelogs'], suppliedAt: RNOW - 3600 }), recentNow));
        check('s155.nofolder.c29.recentLineControl', !!vOf(dC5) && vOf(dC5).evidence.some((l: string) => /recorded as indexed after/.test(l)), vOf(dC5) ? J(vOf(dC5).evidence) : ids(dC5).join(','));

        // (d) Include hana/* plus a plain Include Sources entry: 'may' — the
        // folders are kept, so no ingest verdict at all (never above possible)
        const dD = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'], includeSources: [PAT] })));
        check('s155.nofolder.c29.keptFolderMaySilent', mod.noFolderStatus(TR, fx({ includeFilters: ['hana/*'], includeSources: [PAT] })) === 'may' && !vOf(dD) && noContra(dD), ids(dD).join(','));

        // (e) a dir/subdir=pattern Include Sources entry: may keep files of
        // the folder, but never the folder-less ones (dropped for certain)
        const dE = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['linux/*'], includeSources: ['hana/tracelogs=/usr/sap/*'] })));
        const vE = vOf(dE);
        check('s155.nofolder.c29.scopedPartly', !!vE && vE.short === 'Partly excluded?' && vE.confidence === 'possible', brief(vE, dE));
        check('s155.nofolder.c29.scopedNamesBoth', !!vE && vE.evidence[0].indexOf('`sap:hana:tracelogs` events without folder fields') !== -1 && vE.evidence.some((l: string) => l.indexOf('unless the Include Sources rules keep some of their files: hana/tracelogs') !== -1), vE ? J(vE.evidence) : '-');
        // a plain Include Sources entry behind the same gate: both parts may
        // be kept — "Possibly excluded?", with the line
        const dE2 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['linux/*'], includeSources: [PAT] })));
        check('s155.nofolder.c29.plainGatePossibly', !!vOf(dE2) && vOf(dE2).short === 'Possibly excluded?' && vOf(dE2).confidence === 'possible' && hasLine(vOf(dE2)), brief(vOf(dE2), dE2));
        // a gate with no source rules drops both parts: the full verdict
        // stays (the no-folder part changed no status) and carries the line
        const dE3 = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['linux/*'] })));
        const vE3 = vOf(dE3);
        check('s155.nofolder.c29.gateBothDroppedConfirmed', !!vE3 && vE3.short === 'Excluded at ingest' && vE3.confidence === 'confirmed' && hasLine(vE3), brief(vE3, dE3));

        // (f) controls: sap:hana:audit has no no-folder route — verdicts as
        // before, byte for byte, and never the line
        const dF = cascade.diagnosePanel(pfA, ev(fx({ includeFilters: ['linux/*'] })));
        const vF = vOf(dF);
        check('s155.nofolder.c29.auditControlConfirmed', !!vF && vF.short === 'Excluded at ingest' && vF.confidence === 'confirmed', brief(vF, dF));
        check(
            's155.nofolder.c29.auditControlBytes',
            !!vF &&
                vF.headline === '`sap:hana:audit` events are not covered by the configured include list `linux/*` — they are dropped before they reach the index.' &&
                vF.evidence[0] === 'Dropped at ingest by the supplied filters: hana/hanaaudit' &&
                vF.evidence.length === 3,
            vF ? J(vF) : '-',
        );
        check('s155.nofolder.c29.auditControlNoLine', !hasLine(vF));
        for (const [label, over] of [['exclude', { excludeFilters: ['hana/hanaaudit'] }], ['gateScoped', { includeFilters: ['linux/*'], includeSources: ['hana/hanaaudit=/x'] }], ['gatePlain', { includeFilters: ['linux/*'], includeSources: [PAT] }]] as Array<[string, Record<string, unknown>]>) {
            const d = cascade.diagnosePanel(pfA, ev(fx(over)));
            check(`s155.nofolder.c29.auditNoLine.${label}`, !!vOf(d) && !hasLine(vOf(d)), brief(vOf(d), d));
        }
        // a panel over both types where only the audit unit fires: the line
        // concerns the trace type only, so it is not shown (U41)
        const dTA = cascade.diagnosePanel(pfTA, ev(fx({ excludeFilters: ['hana/hanaaudit'] })));
        check('s155.nofolder.c29.mixedPanelAuditOnlyNoLine', !!vOf(dTA) && !hasLine(vOf(dTA)), brief(vOf(dTA), dTA));
        check('s155.nofolder.c29.mixedPanelAuditOnlySilentOnTrace', !!vOf(dTA) && vOf(dTA).headline.indexOf(TR) === -1 && vOf(dTA).detail.indexOf('without folder fields') === -1, brief(vOf(dTA), dTA));
        // a panel over both types where both folders are excluded: the
        // folder-less trace files may still be kept, so no full drop (the
        // no-folder part withdraws that claim wherever the type is judged),
        // but the line is for a HANA Trace panel only (U41)
        const dTA2 = cascade.diagnosePanel(pfTA, ev(fx({ excludeFilters: ['hana/*'] })));
        check('s155.nofolder.c29.mixedPanelBothPartlyNoLine', !!vOf(dTA2) && !hasLine(vOf(dTA2)) && vOf(dTA2).short === 'Partly excluded?' && vOf(dTA2).confidence === 'possible' && vOf(dTA2).headline.indexOf('`sap:hana:tracelogs` events that arrive without folder fields are not reached by folder filters and may still be kept.') !== -1, brief(vOf(dTA2), dTA2));
        // a mixed panel adds no no-folder claim (review, U41 scope): with a
        // Recipe 1 allow-list and nothing ever seen, the confirmed "Never
        // received" stays the top with no ingest verdict at all; Environment
        // Health's critical-events panel is the real case
        const dTA3 = cascade.diagnosePanel(pfTA, ev(fx({ includeFilters: R1 }), never));
        check('s155.nofolder.c29.mixedPanelRecipe1NeverSeen', dTA3.top.id === 'sourcetype-never-seen' && dTA3.top.confidence === 'confirmed' && !vOf(dTA3) && !dTA3.all.some((v: any) => hasLine(v)), ids(dTA3).join(','));
        const pfEH = pfOf('`sap_logserv_idx_macro` ((sourcetype="sap:hana:audit" status!="SUCCESSFUL") OR (sourcetype="sap:abap:dispatcher" (dp_severity="ERROR" OR dp_severity="FATAL")) OR (sourcetype="sap:hana:tracelogs" hana_trace_severity="fatal") OR (sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="XmlWinEventLog" severity="critical")) | head 200');
        const dEH = cascade.diagnosePanel(pfEH, ev(fx({ includeFilters: R1 }), never));
        check('s155.nofolder.c29.envHealthCriticalNeverSeen', dEH.top.id === 'sourcetype-never-seen' && dEH.top.confidence === 'confirmed' && !vOf(dEH) && !dEH.all.some((v: any) => hasLine(v)), ids(dEH).join(','));
        // a panel that also reads a type with no folder at all (the base
        // sourcetype) is not a HANA Trace panel either
        const pfTU = pfOf('`sap_logserv_idx_macro` (sourcetype="sap:hana:tracelogs" OR sourcetype="sap_logserv_logs") | stats count by sourcetype');
        const dTU = cascade.diagnosePanel(pfTU, ev(fx({ includeFilters: R1 }), never));
        check('s155.nofolder.c29.mixedPanelUnmappedNoClaim', dTU.top.id === 'sourcetype-never-seen' && !vOf(dTU) && !dTU.all.some((v: any) => hasLine(v)), ids(dTU).join(','));
        // ... and with a scoped Include Sources entry the wording is the
        // folder-only one: the folder-less drop is not named, no line
        const dTA4 = cascade.diagnosePanel(pfTA, ev(fx({ includeFilters: ['linux/*'], includeSources: ['hana/tracelogs=/usr/sap/*'] })));
        check(
            's155.nofolder.c29.mixedPanelScopedFolderOnly',
            !!vOf(dTA4) &&
                vOf(dTA4).short === 'Partly excluded?' &&
                vOf(dTA4).headline ===
                    'Some of the sources that feed this view are excluded at ingest by the supplied filter configuration: hana/hanaaudit (approximate \u2014 source rules may drop or keep some files of a folder). Others may be dropped too unless the Include Sources rules keep them: hana/tracelogs.' &&
                !hasLine(vOf(dTA4)),
            brief(vOf(dTA4), dTA4),
        );

        // (g) filtering disabled or unknown: check 29 does not fire at all
        for (const [label, en] of [['disabled', false], ['unknown', null]] as Array<[string, boolean | null]>) {
            const d = cascade.diagnosePanel(pfT, ev(fx({ includeFilters: ['hana/*'], filterEnabled: en })));
            check(`s155.nofolder.c29.${label}Silent`, !vOf(d) && noContra(d), ids(d).join(','));
        }

        // the cached tier reaches the same verdict through the source scope
        const pfC = pfOf('| inputlookup logserv_hana_trace_rollup where metric="main" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count');
        const cachedEv = (fxo: any, lastSeen: Record<string, number> = {}): any =>
            ev(fxo, {
                sourcetypeLastSeen: lastSeen,
                collectionRowsInWindow: 0,
                collectionRowsAllMetrics: 0,
                collectionExtentProbed: true,
                collectionOldest: null,
                collectionNewest: null,
                sourceScope: { sourcetypes: [TR], tags: [], via: 'logserv_hana_trace_aggregate' },
            });
        // ... as a lead: the confirmed cached verdicts keep the top (review)
        const dCa = cascade.diagnosePanel(pfC, cachedEv(fx({ includeFilters: ['hana/*'] })));
        check('s155.nofolder.c29.cachedLeadAfterSourceNeverSeen', dCa.top.id === 'rollup-source-never-seen' && dCa.top.confidence === 'confirmed' && !!vOf(dCa) && vOf(dCa).short === 'Partly excluded?' && vOf(dCa).confidence === 'possible' && hasLine(vOf(dCa)) && ids(dCa).indexOf('ingest-type-excluded') > ids(dCa).indexOf('rollup-source-never-seen'), ids(dCa).join(','));
        const dCb = cascade.diagnosePanel(pfC, cachedEv(fx({ includeFilters: R1 }), { [TR]: RNOW - 40 * 86400 }));
        check('s155.nofolder.c29.cachedLeadAfterNeverBuilt', dCb.top.id === 'rollup-never-built' && dCb.top.confidence === 'confirmed' && !!vOf(dCb) && vOf(dCb).confidence === 'possible' && hasLine(vOf(dCb)) && ids(dCb).indexOf('ingest-type-excluded') > ids(dCb).indexOf('rollup-never-built'), ids(dCb).join(','));
        // ... and after the stale-summary verdict (the stale chain's lead)
        const dCs = cascade.diagnosePanel(
            pfC,
            Object.assign(cachedEv(fx({ includeFilters: R1 }), { [TR]: RNOW - 40 * 86400 }), {
                collectionOldest: RNOW - 90 * 86400,
                collectionNewest: RNOW - 10 * 86400,
            }),
        );
        check('s155.nofolder.c29.cachedLeadAfterStale', dCs.top.id === 'rollup-stale' && dCs.top.confidence === 'likely' && !!vOf(dCs) && vOf(dCs).confidence === 'possible' && hasLine(vOf(dCs)) && ids(dCs).indexOf('ingest-type-excluded') > ids(dCs).indexOf('rollup-stale'), ids(dCs).join(','));
        // a folder drop on the cached tier is still the verdict, on top
        const dCc = cascade.diagnosePanel(pfC, cachedEv(fx({ includeFilters: ['linux/*'] }), { [TR]: RNOW - 40 * 86400 }));
        check('s155.nofolder.c29.cachedFolderDropTop', dCc.top.id === 'ingest-type-excluded' && dCc.top.short === 'Excluded at ingest' && hasLine(dCc.top), ids(dCc).join(','));
        // a mixed rollup scope (the severity aggregate) adds no no-folder
        // claim: an allow-list of its folders and an empty collection stay
        // "Summary not built"
        const SEV = ['sap:abap:dispatcher', 'sap:abap:icm', 'sap:abap:gateway', 'sap:hana:audit', TR, 'sap:sapstartsrv', 'linux_secure', 'sap:saprouter', 'sap:webdispatcher:access', 'squid:access', 'XmlWinEventLog', 'sap:scc:audit', 'sap:scc:http_access'];
        const sevFolders: string[] = [];
        const sevSeen: Record<string, number> = {};
        for (const st of SEV) {
            for (const p of mod.SOURCETYPE_CLZ_MAP[st]) if (sevFolders.indexOf(p) === -1) sevFolders.push(p);
            sevSeen[st] = RNOW - 40 * 86400;
        }
        const pfSev = pfOf('| inputlookup logserv_severity_rollup | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | stats sum(count) as count');
        const dSev = cascade.diagnosePanel(
            pfSev,
            ev(fx({ includeFilters: sevFolders }), {
                sourcetypeLastSeen: sevSeen,
                collectionRowsInWindow: 0,
                collectionRowsAllMetrics: 0,
                collectionExtentProbed: true,
                sourceScope: { sourcetypes: SEV, tags: [], via: 'logserv_severity_aggregate' },
            }),
        );
        check('s155.nofolder.c29.mixedSeverityRollupNeverBuilt', dSev.top.id === 'rollup-never-built' && dSev.top.confidence === 'confirmed' && !vOf(dSev) && !dSev.all.some((v: any) => hasLine(v)), ids(dSev).join(','));
    }

    // --- the report (the display consumer) -----------------------------------
    {
        const report = require('./diagReport') as any;
        const rows = (f: any): string[][] => {
            const sec = report.ingestFactsSection(f, NOW);
            const tbl = sec.blocks.filter((b: any) => b.kind === 'table')[0];
            return tbl ? tbl.table.rows : [];
        };
        const fR = facts({ includeFilters: ['hana/*'], includeSources: ['/usr/sap/*/trace/*'], excludeSources: ['/var/log/zypper.log'] });
        const rR = rows(fR);
        check('s154.report.incRow', rR.some((r) => r[0] === 'Include sources' && r[1] === '/usr/sap/*/trace/*'), J(rR));
        check('s154.report.excRow', rR.some((r) => r[0] === 'Exclude sources' && r[1] === '/var/log/zypper.log'), J(rR));
        check('s154.report.noteRow', rR.some((r) => r[0] === 'Source rules' && r[1].indexOf(mod.SOURCE_RULES_NOTE) !== -1), J(rR));
        const rNone = rows(facts({ includeFilters: ['hana/*'] }));
        check('s154.report.noRowsWithout', !rNone.some((r) => /sources|Source rules/.test(r[0])), J(rNone));
        const jR = report.ingestFactsJson(fR);
        check('s154.report.json', J(jR.includeSources) === J(['/usr/sap/*/trace/*']) && J(jR.excludeSources) === J(['/var/log/zypper.log']) && jR.sourceRulesApproximate === true, J(jR));
        const legacyR = facts({});
        delete (legacyR as Record<string, unknown>).includeSources;
        delete (legacyR as Record<string, unknown>).excludeSources;
        const jL = report.ingestFactsJson(legacyR);
        check('s154.report.jsonLegacy', J(jL.includeSources) === '[]' && J(jL.excludeSources) === '[]' && jL.sourceRulesApproximate === false, J(jL));
    }

    if (failures === 0) {
        // eslint-disable-next-line no-console
        console.log(`diagIngestFacts consistency test: ${checks} checks OK`);
    } else {
        proc.stderr.write(`diagIngestFacts consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};

export {};
