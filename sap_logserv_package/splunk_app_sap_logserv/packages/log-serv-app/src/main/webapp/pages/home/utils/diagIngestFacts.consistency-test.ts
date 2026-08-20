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
    // §19.8a-9 — 16 -> 17 with cloud_provider_stamp (L6's pin update).
    check('const.fields', Array.isArray(mod.DIAG_INGEST_FACT_FIELDS) && mod.DIAG_INGEST_FACT_FIELDS.length === 17);
    check('const.fieldsStamp', mod.DIAG_INGEST_FACT_FIELDS.indexOf('cloud_provider_stamp') !== -1);
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
    check('b2.mixedStarNotPassAll', mod.isPassAllInclude(['*', 'linux/cron']) === false);
    check('b2.mixedStarDropsOthers', mod.typeDropStatus('squid:access', facts({ includeFilters: ['*', 'linux/cron'] })) === 'dropped');
    check('b2.mixedStarKeepsNamed', mod.typeDropStatus('linux:cron', facts({ includeFilters: ['*', 'linux/cron'] })) === 'kept');
    check('b2.excludeStarInert', mod.typeDropStatus('squid:access', facts({ excludeFilters: ['*'] })) === 'kept');
    check('b2.allSlashlessPassAll', mod.isPassAllInclude(['foo', 'bar']) === true);
    check('b2.multiSlashNothing', mod.typeDropStatus('squid:access', facts({ includeFilters: ['proxy/squid/extra'] })) === 'dropped');
    check('b2.starStarInMixed', mod.isPassAllInclude(['linux/cron', '*/*']) === true);
    check('eval.passAllDefault', mod.typeDropStatus('squid:access', facts({})) === 'kept');
    check('eval.excluded', mod.typeDropStatus('squid:access', facts({ excludeFilters: ['proxy/squid'] })) === 'dropped');
    check('eval.excludeWins', mod.typeDropStatus('squid:access', facts({ includeFilters: ['proxy/*'], excludeFilters: ['proxy/squid'] })) === 'dropped');
    check('eval.notIncluded', mod.typeDropStatus('squid:access', facts({ includeFilters: ['linux/*'] })) === 'dropped');
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
    const TC_HARD = [
        '### BEGIN LOGSERV FILTER CONFIG - DO NOT EDIT MANUALLY ###',
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

    if (failures === 0) {
        // eslint-disable-next-line no-console
        console.log(`diagIngestFacts consistency test: ${checks} checks OK`);
    } else {
        proc.stderr.write(`diagIngestFacts consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};

export {};
