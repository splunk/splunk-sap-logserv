/**
 * Build-time consistency test for `host` in the six slowest rollups (build 397).
 *
 * The rule it holds: no number on a page changes because of this, with or without a
 * filter, on an install that rebuilt and on one that did not. Several things could break
 * that without any error, so each has its own section:
 *
 *  - G1-G7: the conf. An event counts once however many host values it has; the hourly
 *    search and the backfill stay one search; the pre-397 key is spelled as it was (every
 *    field distinct, so a swap of two cannot pass); each old row is overwritten with a zero
 *    row when its hour is recounted, so an hour never counts twice and a later Backfill or
 *    late-data repair still corrects it.
 *  - M1: the tail, run. A small model of KV Store's upsert runs the tail's real key
 *    expressions and its real zero-row eval over the cases that matter: the first run after
 *    an upgrade, the second pass, a late delivery, a Backfill with no Clear, a metric that
 *    always had host.
 *  - W1-W4: the time bound put on a rollup read when its job is dispatched. It may only ever
 *    remove rows the range removes anyway, on every form the picker can send.
 *  - T1-T7: the gate's splice and its KV Store reads. bin/check-host-gate.js runs the real
 *    provider and hooks under jsdom.
 *  - R1-R2: every read of a metric that gained `host` adds its rows up again, on the query
 *    each page really builds (helpers such as trendChart() included).
 *  - N1, A1-A3: the Settings note, and Host Details' Auth Failures.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void } };

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { HOST_ADDED_METRICS, ROLLUP_FILTER_FIELDS, metricGainedHost } = require('./filterCapability');
const {
    FILTER_PENDING_SPL,
    FILTER_UNAVAILABLE_SPL,
    hostGateKey,
    isFilterPending,
    isFilterUnavailable,
    withSidHostTerms,
} = require('./queryFilters');
const { KV_WINDOW_COLLECTIONS, KV_WINDOW_MARGIN_SEC, kvWindowLowerBound, kvWindowNeedsClock, withKvWindow } = require('./kvWindow');
const { extractAggregateScope } = require('./diagEvidence');
const { producerSplForOpenInSearch } = require('./diagReport');
const { classifyTail, parseUnion, splitCommands } = require('./backfillPlan');
const {
    HOST_GATE_METRICS,
    hostGateControlQuery,
    hostGateQuery,
    hostGateUrl,
    readHostGate,
    uniformHostGate,
} = require('./hostGate');

const HOME = path.resolve(__dirname, '..');
const RES = path.resolve(__dirname, '../../../../resources/splunk');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string): string => read(path.join(HOME, rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const COLLECTIONS: { [rollup: string]: string[] } = {
    severity: ['authfail', 'icmsev', 'trend', 'web'],
    compliance: ['main', 'password', 'permgrant', 'userchg'],
    xstack_auth: ['fail', 'failip', 'hanauser'],
    perimeter: ['activity', 'dnscount', 'dnsq', 'dnstype', 'proxy', 'proxydom'],
    linux: ['kernel', 'sapapp', 'total'],
    sapservices: ['main', 'ssl'],
};
const collectionOf = (rollup: string): string => `logserv_${rollup}_rollup`;
/** Build 398: the ten other rollups the dashboards read, which take the time bound too. */
const TEN = ['abapnet', 'cloudconn', 'dns', 'hana_category', 'hana_trace', 'proxy', 'saprouter', 'web_timing', 'windows', 'wp_perf'].map(collectionOf);

/* The key each rollup wrote before this build, copied from build 396's conf and not from
 * this one, so a slip in the guard cannot be matched by a slip in this test. `host` was
 * in the formula of three of them, and null on the metrics that gained it. */
const PRE_397_KEY: { [rollup: string]: string[] } = {
    severity: ['metric', 'sourcetype', 'host', 'trend_cat', 'trend_src', 'error_cat', 'status_cat'],
    compliance: ['metric', 'change_source', 'category', 'operator', ''],
    xstack_auth: ['metric', 'layer', 'failed_user', 'src', 'sourcetype', 'src_user', 'action_type', 'status', 'risk_level'],
    perimeter: ['metric', 'fw_action', 'fw_src', 'fw_dst', 'fw_dpt', 'fw_proto', 'host', 'url_domain', 'src_ip', 'query_type', 'query', 'src', 'source_type'],
    linux: ['metric', 'host', 'sourcetype', 'fw_action', 'fw_src', 'fw_dst', 'fw_dpt', 'fw_proto', 'kernel_event', 'sap_app', 'sap_sid', 'sap_inst', 'sap_cid', 'oom_proc', 'lockup_cpu'],
    sapservices: ['metric', 'sourcetype', 'is_auth_event', 'auth_result', 'is_ssl_event', 'severity', 'remote_ip', 'auth_user'],
};

/* What a zero row holds: measures to 0 where the row has them, times gone. */
const ZERO_MEASURES: { [rollup: string]: { zero: string[]; gone: string[] } } = {
    severity: { zero: ['count', 'web_err', 'web_total', 'web_rt_sum', 'web_rt_cnt'], gone: [] },
    compliance: { zero: ['count'], gone: [] },
    xstack_auth: { zero: ['count'], gone: ['last_seen'] },
    perimeter: { zero: ['count', 'denied_count', 'bytes_sum', 'txt_count', 'mx_count'], gone: [] },
    linux: { zero: ['count'], gone: [] },
    sapservices: { zero: ['count'], gone: ['first_ts', 'last_ts'] },
};

/** Evaluates a `metric . ":" . coalesce(x,"")` concatenation over one row. */
const evalHash = (expr: string, row: { [f: string]: string }): string => expr.split(' . ').map((part) => {
    const t = part.trim();
    if (t === 'metric') return row.metric;
    const lit = /^"([^"]*)"$/.exec(t);
    if (lit) return lit[1];
    const m = /^coalesce\(([a-zA-Z_]+),""\)$/.exec(t);
    if (!m) throw new Error(`unexpected term ${t}`);
    return row[m[1]] === undefined ? '' : row[m[1]];
}).join('');

/** The first balanced argument from `from`. */
const balanced = (s: string, from: number): string => {
    let depth = 1;
    let quoted = false;
    for (let i = from; i < s.length; i += 1) {
        const c = s[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === '(') depth += 1;
        else if (!quoted && c === ')') {
            depth -= 1;
            if (depth === 0) return s.slice(from, i);
        }
    }
    return '';
};
const FIELD_OF_HASH = (expr: string): string[] => (expr.match(/coalesce\(([a-zA-Z_]+),""\)/g) || [])
    .map((m) => (/coalesce\(([a-zA-Z_]+)/.exec(m) as RegExpExecArray)[1]);

/** Every field different, so a swap of any two changes the string. */
const distinctRow = (fields: string[], metric: string): { [f: string]: string } => {
    const row: { [f: string]: string } = { metric };
    fields.forEach((f) => {
        row[f] = `v_${f}`;
    });
    return row;
};

/** Runs the top level of a dashboard's source with its React imports stubbed, so helpers
 *  give the strings the page gives. Only firewallChains supplies values to a query. */
const STUB: any = new Proxy(function stub() { /* nothing */ }, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === '__esModule' ? true : STUB),
    apply: () => STUB,
    construct: () => STUB,
});
const queriesOf = (page: string, which = 'Q_BASE'): { [k: string]: string } => {
    const file = path.join(HOME, 'dashboards', `${page}.tsx`);
    const opts = {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.React, esModuleInterop: true },
        fileName: file,
    };
    const load = (abs: string): any => {
        const f = fs.existsSync(`${abs}.ts`) ? `${abs}.ts` : `${abs}.tsx`;
        const m: any = { exports: {} };
        // eslint-disable-next-line no-new-func
        new Function('exports', 'require', 'module', ts.transpileModule(fs.readFileSync(f, 'utf8'), opts).outputText)(m.exports, () => STUB, m);
        return m.exports;
    };
    const js = `${ts.transpileModule(fs.readFileSync(file, 'utf8'), opts).outputText}\nmodule.exports.__Q = ${which};`;
    const m: any = { exports: {} };
    const req = (s: string): any => (/firewallChains$/.test(s) ? load(path.resolve(path.dirname(file), s)) : STUB);
    // eslint-disable-next-line no-new-func
    new Function('exports', 'require', 'module', js)(m.exports, req, m);
    return m.exports.__Q;
};

export const run = async (): Promise<number> => {
    let failures = 0;
    let checks = 0;
    const check = (label: string, ok: boolean, detail = ''): void => {
        checks += 1;
        if (!ok) {
            failures += 1;
            process.stderr.write(`FAIL ${label}${detail ? `: ${detail}` : ''}\n`);
        }
    };

    const SAVED = read(path.join(RES, 'default', 'savedsearches.conf'));
    const stanzas: { [name: string]: string } = {};
    {
        let cur: string | null = null;
        SAVED.split('\n').forEach((line) => {
            const h = /^\[([^\]]+)\]\s*$/.exec(line);
            if (h) cur = h[1];
            else if (cur && line.startsWith('search = ') && stanzas[cur] === undefined) stanzas[cur] = line.slice('search = '.length);
        });
    }
    /** One arm: from its `[search` to its `eval metric="m"]`. */
    const armOf = (spl: string, metric: string): string => {
        const tag = `eval metric="${metric}"]`;
        const end = spl.indexOf(tag);
        if (end === -1) return '';
        const start = spl.lastIndexOf('[search `sap_logserv_idx_macro`', end);
        return start === -1 ? '' : spl.slice(start, end + tag.length);
    };
    const metricsOf = (spl: string): string[] => (spl.match(/eval metric="[a-z_0-9]+"\]/g) || [])
        .map((m) => m.slice('eval metric="'.length, -2));
    const tailOf = (spl: string): string => spl.slice(spl.lastIndexOf('eval metric="'));

    /* ---- G1 the table ---- */
    check('G1a the table lists exactly the six rollups',
        JSON.stringify(Object.keys(HOST_ADDED_METRICS).sort()) === JSON.stringify(Object.keys(COLLECTIONS).map(collectionOf).sort()));
    Object.keys(COLLECTIONS).forEach((r) => {
        const c = collectionOf(r);
        check(`G1b ${r}: the metrics that gained host`,
            JSON.stringify((HOST_ADDED_METRICS[c] || []).slice().sort()) === JSON.stringify(COLLECTIONS[r].slice().sort()), String(HOST_ADDED_METRICS[c]));
        COLLECTIONS[r].forEach((m) => check(`G1c ${r} ${m} is in the capability table`, ROLLUP_FILTER_FIELDS[c].host.indexOf(m) !== -1));
    });
    check('G1d the gate checks each of them once',
        JSON.stringify(HOST_GATE_METRICS.map((m: any) => `${m.collection}|${m.metric}`).sort())
        === JSON.stringify(([] as string[]).concat(...Object.keys(COLLECTIONS).map((r) => COLLECTIONS[r].map((m) => `${collectionOf(r)}|${m}`))).sort()));
    check('G1e the time bound covers the six and the ten other rollups (build 398)',
        JSON.stringify(KV_WINDOW_COLLECTIONS.slice().sort()) === JSON.stringify(Object.keys(COLLECTIONS).map(collectionOf).concat(TEN).sort()),
        KV_WINDOW_COLLECTIONS.join(','));
    {
        // Each has the (metric, bucket_ts) index that makes the bound fast.
        const coll = read(path.join(RES, 'default', 'collections.conf'));
        KV_WINDOW_COLLECTIONS.forEach((c: string) => {
            const at = coll.indexOf(`\n[${c}]`);
            const body = at === -1 ? '' : coll.slice(at + 1, coll.indexOf('\n[', at + 1) === -1 ? coll.length : coll.indexOf('\n[', at + 1));
            check(`G1f ${c} has the (metric, bucket_ts) index`,
                /\naccelerated_fields\.by_metric_bucket\s*=\s*\{\s*"metric"\s*:\s*1\s*,\s*"bucket_ts"\s*:\s*1\s*\}/.test(body), body.slice(0, 120));
        });
    }

    const tailParts: { [r: string]: { newHash: string; oldHash: string; zeroEval: string; hasIf: boolean; ifList: string[]; fields: string[] } } = {};
    Object.keys(COLLECTIONS).forEach((r) => {
        const agg = stanzas[`logserv_${r}_aggregate`] || '';
        const bf = stanzas[`logserv_${r}_backfill`] || '';
        const c = collectionOf(r);

        /* ---- G2 the two searches stay one search ---- */
        check(`G2a ${r}: the backfill runs what the hourly search runs`, !!agg && agg === bf);
        check(`G2b ${r}: the backfill plans one search per arm`, classifyTail(parseUnion(bf).tail).kind === 'row_local', JSON.stringify(classifyTail(parseUnion(bf).tail)));

        /* ---- G3 each arm that gained host ---- */
        metricsOf(agg).forEach((m) => {
            const arm = armOf(agg, m);
            const gained = COLLECTIONS[r].indexOf(m) !== -1;
            check(`G3a ${r} ${m}: one host per event, never dropped`,
                !gained || /\| eval host=mvindex\(host,0\) \| fillnull value="\(none\)" host \| bin _time span=1h( AS bucket_ts)? \| stats /.test(arm), arm.slice(-200));
            check(`G3b ${r} ${m}: host in the grain`,
                !gained || /\bby (?:[a-z_]+, )*host, (?:_time|bucket_ts), cloud_provider\b/.test(arm), arm.slice(-200));
            check(`G3c ${r} ${m}: a metric that had host is untouched`, gained || arm.indexOf('mvindex(host') === -1, arm.slice(-200));
            check(`G3d ${r} ${m}: the table agrees`, metricGainedHost(c, m) === gained);
        });
        COLLECTIONS[r].forEach((m) => check(`G3e ${r} ${m}: the aggregate writes it`, armOf(agg, m) !== ''));

        /* ---- G4 the tail, in order ---- */
        const tail = tailOf(agg);
        const keyAt = tail.indexOf('| eval _key = ');
        const guardAt = tail.indexOf('| eval old_key = ');
        const lookupAt = tail.indexOf(`| lookup ${c} _key AS old_key OUTPUT metric AS old_row | appendpipe [where isnotnull(old_row) AND old_key!=_key | dedup old_key | eval _key=old_key, host="(none)", `);
        const fieldsAtTop = tail.indexOf('] | fields _key,');
        const writeAt = tail.indexOf(`| outputlookup append=true ${c}`);
        // A write can stop at a failed batch and the job say nothing (measured on KV Store). So the
        // zero rows are appended after every new row: a write that stops leaves their old rows alone.
        check(`G4a ${r}: the key, the old key, its lookup, the zero rows after every new row, then the field list and the write`,
            keyAt !== -1 && keyAt < guardAt && guardAt < lookupAt && lookupAt < fieldsAtTop && fieldsAtTop < writeAt, tail.slice(0, 160));
        check(`G4b ${r}: one lookup, and it refuses no row`, (agg.match(/\| lookup /g) || []).length === 1 && agg.indexOf('isnull(old_row)') === -1);
        check(`G4c ${r}: host is stored`, /\| fields _key,[^|]*\bhost\b/.test(tail));
        check(`G4d ${r}: one write, and it ends the search`, tail.endsWith(`| outputlookup append=true ${c}`) && (tail.match(/\| outputlookup /g) || []).length === 1);
        // outputlookup stores every field it is given (measured on KV Store): the write may not see these.
        const fieldClauses = tail.match(/\| fields [^|]*/g) || [];
        check(`G4m ${r}: the write has its field list, and it lists neither of the old key's fields`,
            fieldClauses.length === 1 && !/\bold_(key|row)\b/.test(fieldClauses.join(' ')), fieldClauses.join(' ; ').slice(0, 300));
        check(`G4n ${r}: the planner finds the arms before the tail's brackets`, parseUnion(bf).arms.length === metricsOf(bf).length && parseUnion(bf).tail.indexOf('| eval _key = ') === 0, String(parseUnion(bf).arms.length));

        const lastBranch = tail.indexOf('1==1, substr(sha1(', keyAt);
        const shaNew = lastBranch !== -1 && lastBranch < guardAt ? lastBranch + '1==1, '.length : tail.indexOf('substr(sha1(', keyAt);
        const newHash = balanced(tail, shaNew + 'substr(sha1('.length);
        const shaOld = tail.indexOf('substr(sha1(', guardAt);
        const oldHash = balanced(tail, shaOld + 'substr(sha1('.length);
        const fieldsAll = FIELD_OF_HASH(newHash).concat(FIELD_OF_HASH(oldHash), PRE_397_KEY[r]).filter((f) => f && f !== 'metric');
        const row = distinctRow(fieldsAll, COLLECTIONS[r][0]);
        const noHost = { ...row };
        delete noHost.host;
        const pinned = PRE_397_KEY[r].map((t) => (t === 'metric' ? row.metric : (noHost[t] === undefined ? '' : noHost[t]))).join(':');
        check(`G4e ${r}: the new key changes with the host`, evalHash(newHash, row) !== evalHash(newHash, { ...row, host: 'other' }), newHash);
        check(`G4f ${r}: the old key does not`, evalHash(oldHash, row) === evalHash(oldHash, noHost), oldHash);
        check(`G4g ${r}: the old key is the one build 396 wrote, field by field`, evalHash(oldHash, row) === pinned, `${evalHash(oldHash, row)} vs ${pinned}`);
        check(`G4h ${r}: a new row can never land on an old row`, evalHash(newHash, row) !== evalHash(oldHash, row));

        // Where a rollup keeps metrics that had host, the old key leaves them alone, or each
        // run would zero the row it had just written.
        const others = metricsOf(agg).filter((m) => COLLECTIONS[r].indexOf(m) === -1);
        const ifList = (/old_key = if\(metric IN \(([^)]*)\)/.exec(tail) || ['', ''])[1].split(',').map((s) => s.replace(/"/g, '').trim()).filter((s) => s);
        if (others.length > 0) {
            check(`G4j ${r}: only the metrics that gained host have an old key`, JSON.stringify(ifList.slice().sort()) === JSON.stringify(COLLECTIONS[r].slice().sort()), ifList.join(','));
            check(`G4k ${r}: every other metric has none`, /, null\(\)\) \| lookup /.test(tail.slice(guardAt)));
        } else {
            check(`G4l ${r}: every metric gained host, so every row has an old key`, !/old_key = if\(/.test(tail) && ifList.length === 0);
        }

        /* ---- G5 the zero row ---- */
        const zeroAt = tail.indexOf('| dedup old_key | eval ') + '| dedup old_key | eval '.length;
        const zeroEval = tail.slice(zeroAt, tail.indexOf(']', zeroAt));
        check(`G5e ${r}: the zero rows' fields follow their eval`, tail.indexOf(`${zeroEval}] | fields _key,`) !== -1);
        const want = ['_key=old_key', 'host="(none)"']
            .concat(ZERO_MEASURES[r].zero.map((m) => `${m}=if(isnull(${m}),null(),0)`), ZERO_MEASURES[r].gone.map((m) => `${m}=null()`))
            .join(', ');
        check(`G5a ${r}: the zero row`, zeroEval === want, zeroEval);
        const fieldsAt = tail.indexOf('| fields _key,');
        const fields = tail.slice(fieldsAt + '| fields '.length, tail.indexOf(' |', fieldsAt)).split(',').map((s) => s.trim());
        // Every measure a gained metric's arm computes is zeroed or gone, or its sum would count twice.
        COLLECTIONS[r].forEach((m) => {
            const statsPart = armOf(agg, m).split('| stats ').pop() as string;
            const measures = (statsPart.split(/\bby\b/)[0].match(/\bas ([a-z_]+)/g) || []).map((x) => x.slice(3)).concat(/^count\b|, count\b/.test(statsPart) ? ['count'] : []);
            measures.forEach((f) => check(`G5b ${r} ${m}: ${f} is cleared on a zero row`,
                ZERO_MEASURES[r].zero.indexOf(f) !== -1 || ZERO_MEASURES[r].gone.indexOf(f) !== -1, statsPart.slice(0, 120)));
        });
        tailParts[r] = { newHash, oldHash, zeroEval, hasIf: others.length > 0, ifList, fields };

        // Data Doctor's Open in Search must not hand out either write.
        const opened = producerSplForOpenInSearch(agg);
        check(`G5c ${r}: Open in Search carries no write`, !!opened && !/outputlookup|old_key/i.test(opened) && /cloud_provider$/.test(opened), String(opened).slice(-120));
    });

    check('G5d a zero-row step anywhere else still refuses', producerSplForOpenInSearch(
        '| search x | outputlookup append=true a | eval old_key = 1 | where isnotnull(old_row) | outputlookup append=true a') === null);

    /* ---- G6 the confs that decide what can be stored ---- */
    const TRANSFORMS = read(path.join(RES, 'default', 'transforms.conf'));
    const COLLS = read(path.join(RES, 'default', 'collections.conf'));
    Object.keys(COLLECTIONS).forEach((r) => {
        const c = collectionOf(r);
        const t = new RegExp(`\\[${c}\\][\\s\\S]*?fields_list\\s*=\\s*([^\\n]*)`).exec(TRANSFORMS);
        const list = t ? t[1].split(',').map((s) => s.trim()) : [];
        ['_key', 'bucket_ts', 'metric', 'host', 'count', 'cloud_provider'].forEach((f) => check(`G6a ${r}: the lookup lists ${f}`, list.indexOf(f) !== -1, list.join(',')));
        // Everything the tail writes is listed, so a retention (which writes what it reads) keeps it.
        tailParts[r].fields.filter((f) => f !== 'old_key' && f !== 'old_row').forEach((f) => check(`G6b ${r}: the lookup lists ${f}`, list.indexOf(f) !== -1, list.join(',')));
        check(`G6c ${r}: the old key's fields are not stored`, list.indexOf('old_key') === -1 && list.indexOf('old_row') === -1, list.join(','));
        const s = new RegExp(`\\[${c}\\]\\n([\\s\\S]*?)\\n\\[`).exec(COLLS);
        check(`G6d ${r}: the collection declares host`, !!s && /^field\.host = string$/m.test(s[1]));
        check(`G6e ${r}: reads through the time bound have an index`,
            !!s && /accelerated_fields\.by_metric_bucket = \{"metric": 1, "bucket_ts": 1\}/.test(s[1]));
        check(`G6f ${r}: the gate's reads have an index`,
            !!s && /accelerated_fields\.by_metric_host_bucket = \{"metric": 1, "host": 1, "bucket_ts": 1\}/.test(s[1]));
    });

    /* ---- G7 retention still overwrites with the guard, and reads every field ---- */
    Object.keys(COLLECTIONS).forEach((r) => {
        check(`G7a ${r}: retention untouched`, (stanzas[`logserv_${r}_retention`] || '')
            === `| inputlookup ${collectionOf(r)} | where bucket_ts >= relative_time(now(), "-365d") | outputlookup override_if_empty=false ${collectionOf(r)} | stats count`,
        stanzas[`logserv_${r}_retention`]);
    });

    /* ---- M1 the tail, run on a model of KV Store's upsert ---- */
    type Row = { [f: string]: any };
    const applyZeroEval = (zeroEval: string, row: Row): Row => {
        const out: Row = { ...row };
        zeroEval.split(', ').forEach((a) => {
            const [f, v] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
            if (v === 'old_key') out[f] = row.old_key;
            else if (v === '"(none)"') out[f] = '(none)';
            else if (v === 'null()') delete out[f];
            else if (v === `if(isnull(${f}),null(),0)`) {
                if (out[f] !== undefined) out[f] = 0;
            } else throw new Error(`unexpected zero-row term ${a}`);
        });
        delete out.old_key;
        delete out.old_row;
        return out;
    };
    /** What one run of the tail writes, in order: the old rows are looked up first, then every new row, then a zero row per old row. */
    const tailWrites = (r: string, rows: Row[], kv: Map<string, Row>): Row[] => {
        const { newHash, oldHash, zeroEval, ifList } = tailParts[r];
        const gained = (m: string): boolean => COLLECTIONS[r].indexOf(m) !== -1 && (ifList.length === 0 || ifList.indexOf(m) !== -1);
        const withKeys = rows.map((row) => {
            const k = `${evalHash(newHash, row)}:${row.cloud_provider}:${row.bucket_ts}`;
            const old = gained(row.metric) ? `${evalHash(oldHash, row)}:${row.cloud_provider}:${row.bucket_ts}` : null;
            return { ...row, _key: k, old_key: old, old_row: old !== null && kv.has(old) ? kv.get(old)?.metric : undefined };
        });
        const writes: Row[] = withKeys.map((row) => {
            const stored: Row = { ...row };
            delete stored.old_key;
            delete stored.old_row;
            return stored;
        });
        const seen = new Set<string>();
        withKeys.filter((row) => row.old_row !== undefined && row.old_row !== null && row.old_key !== row._key).forEach((row) => {
            if (seen.has(row.old_key as string)) return;
            seen.add(row.old_key as string);
            writes.push(applyZeroEval(zeroEval, row));
        });
        return writes;
    };
    const runTail = (r: string, rows: Row[], kv: Map<string, Row>): void => {
        tailWrites(r, rows, kv).forEach((w) => kv.set(w._key, w));
    };
    const oldForm = (r: string, row: Row): Row => {
        const noHostRow = { ...row };
        delete noHostRow.host;
        const k = PRE_397_KEY[r].map((t) => (t === 'metric' ? noHostRow.metric : (noHostRow[t] === undefined ? '' : noHostRow[t]))).join(':');
        return { ...noHostRow, _key: `${k}:${row.cloud_provider}:${row.bucket_ts}` };
    };
    const measureOf = (row: Row): number => (row.count !== undefined ? row.count : (row.web_total || 0));
    const sumFor = (kv: Map<string, Row>, metric: string, bucket: number): number => Array.from(kv.values())
        .filter((x) => x.metric === metric && x.bucket_ts === bucket).reduce((n, x) => n + measureOf(x), 0);
    Object.keys(COLLECTIONS).forEach((r) => {
        COLLECTIONS[r].forEach((m) => {
            const dims = distinctRow(FIELD_OF_HASH(tailParts[r].oldHash), m);
            const measure = m === 'web' ? 'web_total' : 'count';
            const base = { ...dims, metric: m, cloud_provider: 'aws' };
            const H = 1790000000;
            const hostRow = (host: string, n: number, bucket = H): Row => ({ ...base, host, bucket_ts: bucket, [measure]: n });
            const oldRow = oldForm(r, { ...base, bucket_ts: H, [measure]: 600 });

            // The first run after an upgrade: the hour holds an old row of 600, and its recount says 720.
            const kv = new Map<string, Row>([[oldRow._key, oldRow]]);
            runTail(r, [hostRow('h1', 300), hostRow('h2', 420)], kv);
            check(`M1a ${r} ${m}: the recount counts once`, sumFor(kv, m, H) === 720, String(sumFor(kv, m, H)));
            const zero = kv.get(oldRow._key) as Row;
            check(`M1b ${r} ${m}: the old row is a zero row with no real host`, measureOf(zero) === 0 && zero.host === '(none)', JSON.stringify(zero).slice(0, 160));
            check(`M1c ${r} ${m}: no row is left without a host`, Array.from(kv.values()).every((x) => !!x.host));
            check(`M1d ${r} ${m}: the host rows and the zero row`, kv.size === 3, String(kv.size));
            const dimsKept = Object.keys(dims).every((f) => f === 'metric' || f === 'host' || zero[f] === (dims as any)[f]);
            check(`M1e ${r} ${m}: a zero row keeps its dims and hour`, dimsKept && zero.bucket_ts === H && zero.cloud_provider === 'aws');
            ZERO_MEASURES[r].gone.forEach((f) => check(`M1f ${r} ${m}: ${f} is gone from a zero row`, zero[f] === undefined));

            // The second pass, a late delivery, a Backfill with no Clear: each corrects the hour.
            runTail(r, [hostRow('h1', 300), hostRow('h2', 420)], kv);
            check(`M1g ${r} ${m}: running it again changes nothing`, sumFor(kv, m, H) === 720 && kv.size === 3, `${sumFor(kv, m, H)} ${kv.size}`);
            runTail(r, [hostRow('h1', 300), hostRow('h2', 660)], kv);
            check(`M1h ${r} ${m}: a late delivery corrects the hour`, sumFor(kv, m, H) === 960 && kv.size === 3, `${sumFor(kv, m, H)} ${kv.size}`);
            runTail(r, [hostRow('h1', 300), hostRow('h2', 660), hostRow('h3', 40)], kv);
            check(`M1i ${r} ${m}: so does a host that arrives late`, sumFor(kv, m, H) === 1000 && kv.size === 4, `${sumFor(kv, m, H)} ${kv.size}`);

            // A write that stops: at no point is the hour below what the old row held. Nothing
            // reports a stop, so this is the difference between visible and silent.
            const stops = tailWrites(r, [hostRow('h1', 300), hostRow('h2', 420)], new Map<string, Row>([[oldRow._key, oldRow]]));
            for (let cut = 0; cut <= stops.length; cut += 1) {
                const part = new Map<string, Row>([[oldRow._key, oldRow]]);
                stops.slice(0, cut).forEach((w) => part.set(w._key, w));
                check(`M1m ${r} ${m}: a write stopped after ${cut} rows never leaves the hour short`, sumFor(part, m, H) >= 600, String(sumFor(part, m, H)));
            }
            check(`M1n ${r} ${m}: the zero row is the last row written`, stops[stops.length - 1]._key === oldRow._key && stops.length === 3);

            // An empty host: in four of the rollups the new key is then the old key, the write
            // lands on the old row, and a zero row would wipe the count it just stored.
            const landed = new Map<string, Row>([[oldRow._key, oldRow]]);
            runTail(r, [hostRow('', 300)], landed);
            check(`M1l ${r} ${m}: an empty host keeps its count`, sumFor(landed, m, H) === 300, `${sumFor(landed, m, H)}`);

            // After a Clear, or an hour with no old row: no zero row.
            const clear = new Map<string, Row>();
            runTail(r, [hostRow('h1', 300), hostRow('h2', 420)], clear);
            check(`M1j ${r} ${m}: with no old row there is no zero row`, clear.size === 2 && sumFor(clear, m, H) === 720, `${clear.size}`);

            // Raw events gone: an old row with no recount stays as it was, in the sums.
            const aged = new Map<string, Row>([[oldRow._key, oldRow]]);
            runTail(r, [hostRow('h1', 5, H + 3600)], aged);
            check(`M1k ${r} ${m}: an hour not recounted keeps its old row`, sumFor(aged, m, H) === 600 && (aged.get(oldRow._key) as Row).host === undefined);
        });
    });
    // A metric that always had host: the same key every run, and no zero row.
    ['severity', 'linux', 'perimeter'].forEach((r) => {
        const m = r === 'severity' ? 'toterr' : 'fw';
        const dims = distinctRow(FIELD_OF_HASH(tailParts[r].newHash), m);
        const row = { ...dims, metric: m, host: 'h1', cloud_provider: 'aws', bucket_ts: 1790000000, count: 7 };
        const kv = new Map<string, Row>();
        runTail(r, [row], kv);
        runTail(r, [{ ...row, count: 9 }], kv);
        check(`M1l ${r} ${m}: a metric that had host rewrites its own row`, kv.size === 1 && Array.from(kv.values())[0].count === 9 && Array.from(kv.values())[0].host === 'h1', `${kv.size}`);
    });

    /* ---- W1 the bound, on every form the picker sends ---- */
    const NOW = 1793750400 + 12345; // some time on 2026-11-04 UTC
    const DAY = 86400;
    const floorDay = (x: number): number => Math.floor(x / DAY) * DAY;
    const presets: [string, number][] = [
        ['-24h@h', 24 * 3600 + 3600],
        ['-7d@h', 7 * DAY + 3600],
        ['-30d@d', 30 * DAY + DAY],
        ['-90d@d', 90 * DAY + DAY],
        ['-1h', 3600],
        ['-15m', 900],
        ['-2w@w0', 14 * DAY + 7 * DAY],
        ['-1mon@mon', 31 * DAY + 31 * DAY],
        ['-1q@q', 92 * DAY + 92 * DAY],
        ['-1y@y', 366 * DAY + 366 * DAY],
        ['-1y', 366 * DAY],
        ['@d', DAY],
        ['@h', 3600],
        ['@w0', 7 * DAY],
        ['@w1', 7 * DAY],
        ['@mon', 31 * DAY],
        ['@q', 92 * DAY],
        ['@y', 366 * DAY],
    ];
    presets.forEach(([e, back]) => {
        const b = kvWindowLowerBound(e, NOW);
        check(`W1a ${e}`, b === floorDay(NOW - back - KV_WINDOW_MARGIN_SEC), String(b));
    });
    check('W1b a bound is a whole UTC day', (kvWindowLowerBound('-7d@h', NOW) as number) % DAY === 0);
    check('W1c the same string all day',
        kvWindowLowerBound('-7d@d', floorDay(NOW) + 1) === kvWindowLowerBound('-7d@d', floorDay(NOW) + DAY - 1));
    check('W1d an epoch', kvWindowLowerBound('1790000000', NOW) === floorDay(1790000000 - KV_WINDOW_MARGIN_SEC));
    check('W1e an epoch with a fraction', kvWindowLowerBound('1790000000.500', NOW) === floorDay(1790000000.5 - KV_WINDOW_MARGIN_SEC));
    check('W1f an ISO time', kvWindowLowerBound('2026-09-01T00:00:00.000Z', NOW) === floorDay(Date.UTC(2026, 8, 1) / 1000 - KV_WINDOW_MARGIN_SEC));
    ['', '0', 'now', 'rt-1h', 'rt', '-1d@d+8h', '-1d@d-1h', '+1d', 'abc', '-7x', '-7d@x', '2026-13-99', '@', '-'].forEach((e) => {
        check(`W1g no bound for "${e}"`, kvWindowLowerBound(e, NOW) === null, String(kvWindowLowerBound(e, NOW)));
    });
    check('W1h no bound for null', kvWindowLowerBound(null, NOW) === null && kvWindowLowerBound(undefined, NOW) === null);
    check('W1i a window older than the margin never goes below the epoch', kvWindowLowerBound('100', NOW) === null);
    check('W1j a relative time waits for the server\'s clock', kvWindowLowerBound('-7d@h', null) === null && kvWindowLowerBound('@d', null) === null);
    check('W1k an absolute time needs no clock', kvWindowLowerBound('1790000000', null) === floorDay(1790000000 - KV_WINDOW_MARGIN_SEC));
    // Against the server's clock, every snap of every preset starts at or after its bound.
    ['-24h@h', '-7d@h', '-30d@d', '-90d@d'].forEach((e) => {
        const m = /^-(\d+)([hd])@([hd])$/.exec(e) as RegExpExecArray;
        const unit = m[2] === 'h' ? 3600 : DAY;
        const snap = m[3] === 'h' ? 3600 : DAY;
        const trueStart = Math.floor((NOW - Number(m[1]) * unit) / snap) * snap;
        check(`W1l ${e} reads from before the start`, (kvWindowLowerBound(e, NOW) as number) <= trueStart);
    });

    /* ---- W2 the rewrite ---- */
    const RANGE = '| addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
    const B7 = kvWindowLowerBound('-7d@h', NOW);
    Object.keys(COLLECTIONS).forEach((r) => {
        const c = collectionOf(r);
        const q = `| inputlookup ${c} where metric="m" ${RANGE} | stats sum(count) as c`;
        check(`W2a ${r} takes the bound before the range`,
            withKvWindow(q, '-7d@h', NOW) === `| inputlookup ${c} where metric="m" AND bucket_ts>=${B7} ${RANGE} | stats sum(count) as c`, withKvWindow(q, '-7d@h', NOW));
    });
    TEN.forEach((c) => {
        const q = `| inputlookup ${c} where metric="m" ${RANGE} | stats sum(count) as c`;
        check(`W2a2 ${c} takes the bound before the range (build 398)`,
            withKvWindow(q, '-7d@h', NOW) === `| inputlookup ${c} where metric="m" AND bucket_ts>=${B7} ${RANGE} | stats sum(count) as c`, withKvWindow(q, '-7d@h', NOW));
    });
    const other = `| inputlookup logserv_hostdetails_rollup where metric="main" ${RANGE} | stats sum(count) as c`;
    check('W2b another rollup is left as it is', withKvWindow(other, '-7d@h', NOW) === other);
    const sev = `| inputlookup logserv_severity_rollup where metric="trend" ${RANGE}`;
    [
        `| inputlookup logserv_severity_rollup ${RANGE} | stats count`, // no metric
        '| inputlookup logserv_severity_rollup where metric="trend" | stats count', // no range
        '| inputlookup logserv_beaconing_rollup where metric="x" | addinfo | where day_ts>=info_min_time AND day_ts<info_max_time',
        '| inputlookup logserv_severity_rollup where metric="trend" | addinfo | where bucket_ts>=relative_time(info_min_time,"-1d")',
        '`sap_logserv_idx_macro` sourcetype="x" | stats count',
        '| tstats count WHERE `sap_logserv_idx_macro` BY host',
        FILTER_UNAVAILABLE_SPL,
        FILTER_PENDING_SPL,
        '',
    ].forEach((q, i) => check(`W2c shape ${i} is left as it is`, withKvWindow(q, '-7d@h', NOW) === q, q));
    check('W2d no bound for the range: the read is left as it is', withKvWindow(sev, '0', NOW) === sev && withKvWindow(sev, 'rt-1h', NOW) === sev);
    check('W2i no clock yet: the read is left as it is', withKvWindow(sev, '-7d@h', null) === sev);
    check('W2e with the cloud and host terms after the range',
        withKvWindow(`${sev} | search cloud_provider="aws" | search host="a" | stats count`, '-7d@h', NOW)
        === `| inputlookup logserv_severity_rollup where metric="trend" AND bucket_ts>=${B7} ${RANGE} | search cloud_provider="aws" | search host="a" | stats count`);
    check('W2f both reads of a query',
        (withKvWindow(`${sev} | append [${sev}]`, '-7d@h', NOW).match(/AND bucket_ts>=/g) || []).length === 2);
    check('W2g a bound is never put in twice', (() => {
        const once = withKvWindow(sev, '-7d@h', NOW);
        return withKvWindow(once, '-7d@h', NOW) === once;
    })());
    check('W2h taking the bound out gives the query back', (() => {
        const q = `| inputlookup logserv_linux_rollup where metric="kernel" ${RANGE} | search kernel_event="FWD_DROP" | stats count`;
        return withKvWindow(q, '-30d@d', NOW).replace(/ AND bucket_ts>=\d+/, '') === q;
    })());

    /* ---- W3 only where the job is dispatched, on the server's clock ---- */
    const search = code('hooks/useSearch.ts');
    check('W3a the job gets the bound, on the server\'s clock', /search: withKvWindow\(query, effectiveEarliest, serverNowSec\(\)\),/.test(search));
    check('W3b the panel keeps the query as written', /\n\s+spl: query,\n/.test(search) && (search.match(/withKvWindow\(/g) || []).length === 1);
    const home = (fs.readdirSync(path.join(HOME, 'dashboards')) as string[]).filter((f) => code(`dashboards/${f}`).indexOf('withKvWindow') !== -1);
    check('W3c no dashboard applies it itself', home.length === 0, home.join(','));
    check('W3d no bound is worked out from the browser\'s clock alone',
        code('state/SidHostFilterProvider.tsx').indexOf('kvWindowLowerBound(timeRange.earliest, serverNowSec())') !== -1
        && code('state/SidHostFilterProvider.tsx').indexOf('kvWindowLowerBound(timeRange.earliest, Date.now') === -1);

    /* ---- W4 the margin the comments state ---- */
    check('W4a the margin', KV_WINDOW_MARGIN_SEC === 2 * DAY);

    /* ---- W5 a read that would take the bound waits for the server's clock (build 398, the 397 audit's M5) ---- */
    {
        const sevQ = `| inputlookup logserv_severity_rollup where metric="trend" ${RANGE} | stats sum(count) as c`;
        const dnsQ = `| inputlookup logserv_dns_rollup where metric="main" ${RANGE} | stats sum(count) as c`;
        const hdQ = `| inputlookup logserv_hostdetails_rollup where metric="m" ${RANGE}`;
        check('W5a a listed read over a relative range waits', kvWindowNeedsClock(sevQ, '-7d@h') && kvWindowNeedsClock(dnsQ, '-30d@d') && kvWindowNeedsClock(sevQ, '@d'));
        check('W5b an absolute range does not wait (it needs no clock)', !kvWindowNeedsClock(sevQ, '1790000000') && !kvWindowNeedsClock(sevQ, '2026-09-01T00:00:00.000Z'));
        check('W5c a range that never takes a bound does not wait',
            ['0', 'rt-1h', '', '-7d@d-1h'].every((e) => !kvWindowNeedsClock(sevQ, e)) && !kvWindowNeedsClock(sevQ, null) && !kvWindowNeedsClock(sevQ, undefined));
        check('W5d a read outside the list, or in another shape, does not wait',
            !kvWindowNeedsClock(hdQ, '-7d@h') && !kvWindowNeedsClock('| inputlookup logserv_severity_rollup where metric="trend" | stats count', '-7d@h'));
        check('W5e a raw search does not wait', !kvWindowNeedsClock('`sap_logserv_idx_macro` sourcetype="x" | stats count', '-7d@h'));
        check('W5f it waits exactly when the job would take a bound once the clock is known',
            [sevQ, dnsQ, hdQ, `${hdQ} | append [${dnsQ}]`].every((q) => ['-7d@h', '-30d@d', '0', '1790000000'].every((e) =>
                kvWindowNeedsClock(q, e) === (withKvWindow(q, e, null) === q && withKvWindow(q, e, NOW) !== q))));
        check('W5g the same answer twice in a row (no regex state left over)',
            kvWindowNeedsClock(sevQ, '-7d@h') && kvWindowNeedsClock(sevQ, '-7d@h') && kvWindowNeedsClock(`${hdQ} | append [${dnsQ}]`, '-7d@h'));
        check('W5h useSearch holds such a query until the clock settles, and only such a query',
            /const waitsForClock = !!enabled && !!query && !serverClockSettled\(\) && kvWindowNeedsClock\(query, effectiveEarliest\);/.test(search)
            && /\n {8}if \(waitsForClock\) \{\n {12}setResults\(null\);\n {12}setRowsFor\(rowsKey\);\n {12}setLoading\(true\);\n {12}setError\(null\);\n {12}setSid\(undefined\);\n {12}setDispatchedAt\(undefined\);\n {12}return undefined;\n {8}\}/.test(search)
            && /\}, \[query, effectiveEarliest, effectiveLatest, enabled, count, effectiveRefreshNonce, waitsForClock\]\);/.test(search));
        check('W5i the wait starts the clock read and ends when it settles',
            /startServerClock\(\);\n\s+onServerClockSettled\(\(\) => \{\n\s+if \(live\) setClockTick\(\(n\) => n \+ 1\);/.test(search));
    }

    /* ---- W6 the ten other rollups: every read on their pages takes the bound (build 398) ---- */
    {
        const TEN_PAGES = ['AbapOperations', 'AbapSecurity', 'CloudConnector', 'DnsAnalytics', 'HanaAudit', 'HanaTrace', 'Proxy',
            'SapRouter', 'WebApiPerformance', 'WebDispatcher', 'Windows', 'WorkProcessPerformance'];
        let tenReads = 0;
        TEN_PAGES.forEach((page) => {
            let q: { [k: string]: string } = {};
            try {
                q = queriesOf(page);
            } catch (e) {
                check(`W6y ${page}: its queries load`, false, String(e));
            }
            check(`W6z ${page}: its queries were read`, Object.keys(q).length > 5, String(Object.keys(q).length));
            Object.keys(q).forEach((name) => {
                if (typeof q[name] !== 'string') return;
                const spl = q[name].replace(/__LSV_SPAN__/g, '1d');
                const all = spl.match(/\| inputlookup logserv_[a-z_]+_rollup where metric="[^"]*"/g) || [];
                const ofTen = all.filter((r) => TEN.some((c) => r.indexOf(` ${c} `) !== -1));
                if (ofTen.length === 0) return;
                tenReads += ofTen.length;
                // Every read of a listed collection in the query, the ten's and the six's.
                const listed = all.filter((r) => KV_WINDOW_COLLECTIONS.some((c: string) => r.indexOf(` ${c} `) !== -1));
                const bounded = withKvWindow(spl, '-7d@h', NOW);
                const got = (bounded.match(/ AND bucket_ts>=\d+ \| addinfo/g) || []).length;
                check(`W6a ${page}.${name}: each of its reads takes the bound`, got === listed.length, `${got} of ${listed.length}: ${spl.slice(0, 160)}`);
                check(`W6b ${page}.${name}: nothing else changes`, bounded.replace(/ AND bucket_ts>=\d+/g, '') === spl);
            });
        });
        check('W6c the ten pages\' reads were found', tenReads >= 60, String(tenReads));
    }

    /* ---- W7 the KPI cards that showed a dash under a filter (build 398, the 397 audit's M1) ---- */
    {
        const emptySafe = (q: string): boolean => /\| stats count as n, /.test(q) && /\| fillnull value=0 /.test(q);
        const eh = queriesOf('EnvironmentHealth');
        ['totalErrors', 'hanaFailures', 'authFailures', 'firewallDrops', 'webErrorRate'].forEach((k) =>
            check(`W7a EnvironmentHealth.${k} is empty-safe`, emptySafe(eh[k] || ''), (eh[k] || '').slice(0, 160)));
        check('W7b the Web Error Rate reads 0 % with no row', /\| stats count as n, sum\(web_err\) as errors, sum\(web_total\) as total \| fillnull value=0 errors total \| eval pct = if\(total>0, /.test(eh.webErrorRate || ''));
        const npRaw = queriesOf('NetworkPerimeter', 'QRAW_BASE');
        check('W7c Network Perimeter: the raw Outbound card is empty-safe, like its rollup twin',
            emptySafe(npRaw.kpiBw || '') && emptySafe(queriesOf('NetworkPerimeter').kpiBw || ''), (npRaw.kpiBw || '').slice(0, 160));
    }

    /* ---- T1 the gate, in the splice ---- */
    const TREND = `| inputlookup logserv_severity_rollup where metric="trend" ${RANGE} | stats sum(count) as c`;
    const TOTERR = `| inputlookup logserv_severity_rollup where metric="toterr" ${RANGE} | stats sum(count) as c`;
    const key = hostGateKey('logserv_severity_rollup', 'trend');
    const OR2 = '(host="h1" OR host="h2")';
    const terms = (state?: string): any => ({
        hosts: ['h1', 'h2'],
        sids: [],
        ...(state ? { hostGate: { [key]: state } } : {}),
    });
    check('T1a ready: the rollup takes the host term',
        withSidHostTerms(TREND, terms('ready')) === `| inputlookup logserv_severity_rollup where metric="trend" ${RANGE} | search ${OR2} | stats sum(count) as c`);
    check('T1b old: the raw arm', isFilterUnavailable(withSidHostTerms(TREND, terms('old'))));
    check('T1c pending: wait', isFilterPending(withSidHostTerms(TREND, terms('pending'))));
    check('T1d no answer at all reads as old', isFilterUnavailable(withSidHostTerms(TREND, terms())));
    check('T1e a metric that always had host takes no check', withSidHostTerms(TOTERR, terms()).indexOf(`| search ${OR2}`) !== -1);
    check('T1f no filter: nothing changes, whatever the gate says', withSidHostTerms(TREND, null) === TREND);
    check('T1g one read that cannot be filtered wins over one still waiting', isFilterUnavailable(withSidHostTerms(
        `${TREND} | append [| inputlookup logserv_proxy_rollup where metric="core" ${RANGE}]`, terms('pending'))));
    check('T1h one read waiting holds the whole query', isFilterPending(withSidHostTerms(`${TOTERR} | append [${TREND}]`, terms('pending'))));
    check('T1i a marker stays itself', withSidHostTerms(FILTER_PENDING_SPL, terms('ready')) === FILTER_PENDING_SPL);
    check('T1j the markers differ, and neither reads as the other',
        FILTER_PENDING_SPL !== FILTER_UNAVAILABLE_SPL && !isFilterPending(FILTER_UNAVAILABLE_SPL) && !isFilterUnavailable(FILTER_PENDING_SPL));
    check('T1k the marker runs nothing if it ever is dispatched', /^\| makeresults \| where 1=0/.test(FILTER_PENDING_SPL));
    {
        const sapapp = `| inputlookup logserv_linux_rollup where metric="sapapp" ${RANGE} | stats sum(count) as c`;
        const sidKey = hostGateKey('logserv_linux_rollup', 'sapapp');
        const t = (state: string): any => ({ hosts: ['h1'], sids: ['A44'], hostGate: { [sidKey]: state } });
        check('T1l a metric that also stores sap_sid keeps it for a SID while its rows are old',
            withSidHostTerms(sapapp, t('old')).indexOf('| search (sap_sid="A44" OR sap_sid="A44_*")') !== -1);
        check('T1m and the host once they are not', withSidHostTerms(sapapp, t('ready')).indexOf('| search host="h1"') !== -1);
        check('T1n hosts picked by hand over old rows: the raw arm',
            isFilterUnavailable(withSidHostTerms(sapapp, { hosts: ['h1'], sids: [], hostGate: { [sidKey]: 'old' } })));
    }

    /* ---- T2 the KV Store queries ---- */
    check('T2a a row with no host, in the range', hostGateQuery('trend', 1790000000)
        === '{"metric":"trend","bucket_ts":{"$gte":1790000000},"host":null}', hostGateQuery('trend', 1790000000));
    check('T2b the whole metric with no bound', hostGateQuery('trend', null) === '{"metric":"trend","host":null}');
    check('T2e the control: any row in the range', hostGateControlQuery('trend', 1790000000) === '{"metric":"trend","bucket_ts":{"$gte":1790000000}}');
    check('T2f the control with no bound', hostGateControlQuery('trend', null) === '{"metric":"trend"}');
    {
        const u = hostGateUrl('logserv_severity_rollup', 'trend', 1790000000);
        check('T2c one row, URL-encoded, through Splunk Web',
            u.startsWith('/en-US/splunkd/__raw/servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/logserv_severity_rollup?')
            && /[?&]limit=1(&|$)/.test(u) && /[?&]output_mode=json(&|$)/.test(u) && u.indexOf('{') === -1
            && decodeURIComponent(u.slice(u.indexOf('query=') + 6)) === hostGateQuery('trend', 1790000000), u);
        check('T2d never $exists: the REST query refuses it', u.indexOf('exists') === -1);
    }

    /* ---- T3 the read ---- */
    const noHostAsked = (url: string): boolean => decodeURIComponent(url).indexOf('"host":null') !== -1;
    let seen: string[] = [];
    const answers = (f: (url: string) => any) => (url: string): Promise<Response> => {
        seen.push(url);
        return Promise.resolve(f(url));
    };
    const json = (body: unknown, ok = true): any => ({ ok, json: () => Promise.resolve(body) });
    const signal = new AbortController().signal;
    const allAre = (r: any, state: string): boolean => Object.keys(r).length === HOST_GATE_METRICS.length && Object.keys(r).every((k) => r[k] === state);
    {
        const r = await readHostGate(1790000000, signal, answers((u) => json(noHostAsked(u) ? [] : [{ bucket_ts: 1 }])));
        check('T3a no old row and a row in the range: ready, every metric', allAre(r, 'ready'));
        check('T3b two reads per metric', seen.length === 2 * HOST_GATE_METRICS.length, String(seen.length));
    }
    {
        seen = [];
        const r = await readHostGate(null, signal, answers((u) => json(noHostAsked(u) && u.indexOf('logserv_linux_rollup') !== -1 ? [{ bucket_ts: 1 }] : (noHostAsked(u) ? [] : [{ bucket_ts: 1 }]))));
        check('T3c an old row: old, that collection only',
            r[hostGateKey('logserv_linux_rollup', 'total')] === 'old' && r[hostGateKey('logserv_severity_rollup', 'trend')] === 'ready');
    }
    {
        seen = [];
        const r = await readHostGate(null, signal, answers(() => json([{ bucket_ts: 1 }])));
        check('T3i an old row needs no control read', allAre(r, 'old') && seen.length === HOST_GATE_METRICS.length, String(seen.length));
    }
    {
        const r = await readHostGate(null, signal, answers(() => json([])));
        check('T3j an empty answer to both is not ready: KV Store may be warming up', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers((u) => (noHostAsked(u) ? json([]) : json({ error: 'x' }, false))));
        check('T3k a failed control read: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers(() => json({ error: 'x' }, false)));
        check('T3d an HTTP error: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers(() => json([], false)));
        check('T3d2 an HTTP error with an empty list for a body: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers((u) => (noHostAsked(u) ? json([], false) : json([{ bucket_ts: 1 }]))));
        check('T3d3 an HTTP error on the old-row read is no answer, whatever the control finds: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers(() => json({ not: 'a list' })));
        check('T3e not a list: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers((u) => (noHostAsked(u) ? json({ length: 0 }) : json([{ bucket_ts: 1 }]))));
        check('T3e2 not a list, even with a length of 0: old', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, () => Promise.reject(new Error('network')));
        check('T3f a failed read: old, and it does not reject', allAre(r, 'old'));
    }
    {
        const r = await readHostGate(null, signal, answers(() => ({ ok: true, json: () => Promise.reject(new Error('bad json')) })));
        check('T3g a body that does not parse: old', allAre(r, 'old'));
    }
    check('T3h uniformHostGate covers the table', allAre(uniformHostGate('pending'), 'pending'));

    /* ---- T3r the gate answers for the global range, so no reader may have a range of its own ---- */
    {
        const SOURCE_ROOT = path.resolve(__dirname);
        const allFiles: string[] = [];
        const walk = (dir: string): void => fs.readdirSync(dir, { withFileTypes: true }).forEach((e: any) => {
            const p2 = path.join(dir, e.name);
            if (e.isDirectory()) walk(p2);
            else if (/\.tsx?$/.test(e.name) && !/consistency-test/.test(e.name)) allFiles.push(p2);
        });
        const homeRoot = path.resolve(SOURCE_ROOT, '..');
        walk(homeRoot);
        const ownRange = (file: string): string[] => {
            const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2019, true, ts.ScriptKind.TSX);
            const found: string[] = [];
            const isRange = (name: string): boolean => name === 'earliest' || name === 'latest';
            const visit = (n: any): void => {
                if (ts.isJsxAttribute(n) && isRange(n.name.getText())) found.push(`attribute ${n.name.getText()}`);
                if (ts.isCallExpression(n)) {
                    const callee = n.expression.getText();
                    if ((callee === 'useSearch' || callee === 'useHybridSearch') && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
                        n.arguments[0].properties.forEach((a: any) => {
                            if (a.name && isRange(a.name.getText())) found.push(`${callee} ${a.name.getText()}`);
                        });
                    }
                    if (callee === 'useRoutedQuery' && n.arguments.length > 2) found.push('useRoutedQuery with a range');
                }
                ts.forEachChild(n, visit);
            };
            visit(src);
            return found;
        };
        // The six that gained host, not the bound's whole list (build 398 added ten that did not).
        const SIX = Object.keys(COLLECTIONS).map(collectionOf);
        const namesSix = (file: string): boolean => {
            const text = fs.readFileSync(file, 'utf8');
            return SIX.some((c: string) => text.indexOf(c) !== -1);
        };
        const readers = allFiles.filter(namesSix);
        check('T3r1 the walk found the six dashboards', ['ChangeConfig', 'CrossStackAuthentication', 'EnvironmentHealth', 'Linux', 'NetworkPerimeter', 'SapServices']
            .every((d) => readers.some((f) => path.basename(f) === `${d}.tsx`)), readers.map((f) => path.basename(f)).join(','));
        // RollupBackfillPanel names them to write them; its dispatch takes no hook.
        readers.forEach((f) => {
            const own = ownRange(f);
            check(`T3r2 ${path.basename(f)}: a file that names the six passes no range of its own`, own.length === 0, own.join(', '));
        });
        const callers = allFiles.filter((f) => ownRange(f).length > 0);
        check('T3r3 the walk can find a range of its own: the topology hook and the SID list have one',
            callers.some((f) => path.basename(f) === 'useNodeData.ts') && callers.some((f) => path.basename(f) === 'SidHostFilterProvider.tsx'), callers.map((f) => path.basename(f)).join(','));
        const dash = allFiles.filter((f) => /[\\/]dashboards[\\/]/.test(f));
        const gained = ['ChangeConfig', 'CrossStackAuthentication', 'EnvironmentHealth', 'Linux', 'NetworkPerimeter', 'SapServices'];
        dash.filter((f) => gained.indexOf(path.basename(f, '.tsx')) !== -1).forEach((f) => {
            const src = fs.readFileSync(f, 'utf8');
            check(`T3r4 ${path.basename(f)}: no helper hands a chart a range`, !/\b(earliest|latest)\s*[:=]\s*['"`{]/.test(src));
        });
    }

    /* ---- T4 the provider: its behaviour is held by bin/check-host-gate.js ---- */
    const provider = code('state/SidHostFilterProvider.tsx');
    check('T4g a Host-only page takes no gate: its rollups always had host', /if \(service\) terms = picked\.length > 0 \? \{ hosts: picked, sids: \[\] \} : null;/.test(provider));
    check('T4h a Host-only page never reads a metric that gained host', ['SapRouter', 'Proxy', 'DnsAnalytics', 'CloudConnector'].every((p) => {
        const src = code(`dashboards/${p}.tsx`);
        return Object.keys(COLLECTIONS).every((r) => src.indexOf(collectionOf(r)) === -1);
    }));

    /* ---- T5 what waits ---- */
    check('T5a useSearch dispatches nothing while pending', /if \(isFilterPending\(query\)\) \{\s*setResults\(null\);\s*setRowsFor\(rowsKey\);\s*setLoading\(true\);[\s\S]*?return undefined;\s*\}/.test(search));
    check('T5b before the job is created', search.indexOf('isFilterPending(query)') < search.indexOf('.create({'));
    check('T5c a pending panel counts as dispatched, so it reads as loading',
        /const dispatched = !!enabled && !!query && !isFilterUnavailable\(query\);/.test(search));
    {
        const hybrid = code('hooks/useHybridSearch.ts');
        check('T5d useRoutedQuery: pending waits, unless the raw arm serves the range anyway',
            /if \(isFilterPending\(cached\)\) return shouldUseRawSource\(effEarliest, effLatest\) \? raw : cached;/.test(hybrid));
        check('T5e no raw twin is recorded for the marker',
            hybrid.indexOf('isFilterPending(cached)') < hybrid.indexOf('recordRawTwin(cached, raw)'));
    }
    check('T5f the panel menu has nothing to offer while pending',
        /if \(isFilterUnavailable\(spl\) \|\| isFilterPending\(spl\)\) return null;/.test(code('components/PanelMeta.tsx')));
    check('T5g no Diagnose while pending', /!isFilterUnavailable\(search\.spl\) && !isFilterPending\(search\.spl\)/.test(code('components/KpiCard.tsx')));
    check('T5h Data Doctor does not print the marker', /if \(isFilterPending\(spl\)\) return 'Waiting:/.test(code('utils/diagSweep.ts')));

    /* ---- T6 Data Doctor says what is true ---- */
    check('T6a an old summary can be rebuilt', /a Backfill of its row in Settings > Dashboard Data can change this\./.test(code('utils/panelDiagnosis.ts')));

    /* ---- T7 no version in what a user reads ---- */
    check('T7a the new page text names no build', !/build \d+/.test(
        (/headline: 'This panel cannot be filtered[\s\S]*?confidence:/.exec(code('utils/panelDiagnosis.ts')) || [''])[0]));

    /* ---- R1 every read of these metrics adds its rows up again ---- */
    const PAGES = ['ChangeConfig', 'CrossStackAuthentication', 'EnvironmentHealth', 'Linux', 'NetworkPerimeter', 'SapServices'];
    const gainedRead = /\|\s*inputlookup\s+(logserv_[a-z0-9_]+_rollup)\s+where\s+metric="([a-z0-9_]+)"/g;
    const MEASURE_SUM = /^(count|web_err|web_total|web_rt_sum|web_rt_cnt|denied_count|bytes_sum|txt_count|mx_count)$/;
    const TIME_MAX = /^(last_seen|last_ts)$/;
    const TIME_MIN = /^first_ts$/;
    /** Items of a stats clause, split at top-level commas. */
    const items = (clause: string): string[] => {
        const out: string[] = [];
        let depth = 0;
        let cur = '';
        for (let i = 0; i < clause.length; i += 1) {
            const c = clause[i];
            if (c === '(') depth += 1;
            if (c === ')') depth -= 1;
            if (c === ',' && depth === 0) {
                out.push(cur.trim());
                cur = '';
            } else cur += c;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    };
    /** Null when the read adds rows up the way a host grain leaves right; else why not. */
    const whyNot = (spl: string): string | null => {
        const m = /\|\s*(stats|timechart|chart)\b/.exec(spl);
        if (!m) return 'no aggregate';
        const before = spl.slice(0, m.index);
        const after = before.slice(before.indexOf('info_max_time') + 'info_max_time'.length);
        const cmds = splitCommands(after).filter((s: string) => s);
        for (const c of cmds) {
            const name = (/^[a-z]+/.exec(c) || [''])[0];
            if (name !== 'search' && name !== 'eval' && name !== 'where') return `row-level "${name}" before the aggregate`;
            if (name === 'search' && /\bhost\b/.test(c)) return 'a search on host before the aggregate';
            if (name === 'where' && /\b(count|host|web_\w+|bytes_sum|denied_count)\b/.test(c)) return `a filter on a measure or host: ${c}`;
        }
        // The aggregate's function list: to " by ", " over " or the next pipe.
        const rest = spl.slice(m.index + m[0].length);
        const end = rest.indexOf(' | ');
        const whole = (end === -1 ? rest : rest.slice(0, end)).trim();
        const clause = whole.split(/\s(?:by|over)\s/)[0].replace(/^(?:span=\S+|bins=\S+|minspan=\S+)\s*/g, '').replace(/^(?:span=\S+|bins=\S+|minspan=\S+)\s*/g, '');
        for (const it of items(clause)) {
            const bare = /^count(\s+as\s+(\S+))?$/i.exec(it);
            if (bare) {
                if (bare[2] !== 'n') return 'a count of rows that reaches the panel';
                continue;
            }
            const fn = /^([a-z]+)\((.*)\)(\s+as\s+.+)?$/i.exec(it);
            if (!fn) return `cannot read "${it}"`;
            const [name, arg] = [fn[1].toLowerCase(), fn[2].trim()];
            if (name === 'sum') {
                if (!MEASURE_SUM.test(arg) && !/^eval\(if\(.*,\s*count,\s*0\)\)$/.test(arg)) return `sum of "${arg}"`;
            } else if (name === 'max') {
                if (!TIME_MAX.test(arg)) return `max of "${arg}"`;
            } else if (name === 'min') {
                if (!TIME_MIN.test(arg)) return `min of "${arg}"`;
            } else if (name === 'dc' || name === 'values') {
                if (/^(count|host)$/.test(arg)) return `${name} of "${arg}"`;
            } else return `"${name}" depends on the rows it sees`;
        }
        return null;
    };
    const eachGainedRead = (spl: string, f: () => void): void => {
        gainedRead.lastIndex = 0;
        let m = gainedRead.exec(spl);
        while (m) {
            if (metricGainedHost(m[1], m[2])) f();
            m = gainedRead.exec(spl);
        }
    };
    let pageReads = 0;
    PAGES.forEach((page) => {
        const q = queriesOf(page);
        check(`R1z ${page}: its queries were read`, Object.keys(q).length > 5, String(Object.keys(q).length));
        Object.keys(q).forEach((name) => {
            const spl = q[name].replace(/__LSV_SPAN__/g, '1d');
            eachGainedRead(spl, () => {
                pageReads += 1;
                const why = whyNot(spl);
                check(`R1a ${page}.${name} adds its rows up`, why === null, `${why}: ${spl.slice(0, 200)}`);
                const f = withSidHostTerms(spl, { hosts: ['h1'], sids: [], hostGate: uniformHostGate('ready') });
                check(`R1c ${page}.${name} takes the host term once the rows are ready`, f.indexOf('| search host="h1"') !== -1, f.slice(0, 200));
                check(`R1d ${page}.${name} takes the time bound`, /AND bucket_ts>=\d+ \| addinfo/.test(withKvWindow(spl, '-7d@h', NOW)), spl.slice(0, 160));
            });
        });
    });
    check('R1e the page reads were found', pageReads >= 70, String(pageReads));

    /* ---- R2 saved searches and AI prompts ---- */
    let savedReads = 0;
    Object.keys(stanzas).forEach((name) => {
        if (/_(aggregate|backfill|retention)$/.test(name)) return;
        eachGainedRead(stanzas[name], () => {
            savedReads += 1;
            const why = whyNot(stanzas[name]);
            check(`R2a ${name} adds its rows up`, why === null, `${why}: ${stanzas[name].slice(0, 200)}`);
        });
    });
    const intents = read(path.join(RES, 'default', 'data', 'mcp', 'logserv_intent_map.json'));
    (intents.match(/"spl":\s*"(?:[^"\\]|\\.)*"/g) || []).forEach((line) => {
        const spl = JSON.parse(`{${line}}`).spl as string;
        eachGainedRead(spl, () => {
            savedReads += 1;
            const why = whyNot(spl);
            check('R2b an AI prompt adds its rows up', why === null, `${why}: ${spl.slice(0, 200)}`);
        });
    });
    check('R2c those reads were found', savedReads >= 2, String(savedReads));

    /* ---- N1 the Settings note names the table's rows ---- */
    {
        const { ROLLUPS, UPGRADE_NOTE_HOST_GRAIN } = require('../routes/rollupRegistry');
        const rows = UPGRADE_NOTE_HOST_GRAIN.map((k: string) => ROLLUPS.find((d: any) => d.key === k));
        check('N1a every key is a row', rows.every((d: any) => !!d), JSON.stringify(UPGRADE_NOTE_HOST_GRAIN));
        const owned = ([] as string[]).concat(...rows.map((d: any) => d.collections));
        Object.keys(COLLECTIONS).forEach((r) => check(`N1b ${r} is rebuilt by a row the note names`, owned.indexOf(collectionOf(r)) !== -1));
        check('N1c no row more than it needs', rows.every((d: any) => d.collections.some((c: string) => HOST_ADDED_METRICS[c] !== undefined)));
        const panel = code('components/RollupBackfillPanel.tsx');
        check('N1d the panel shows it', /\{upgradeRows\(UPGRADE_NOTE_HOST_GRAIN\)\}/.test(panel));
        const notes = read(path.resolve(__dirname, '../../../../../../../../../../docs/content/overview/release-notes.md'));
        rows.forEach((d: any) => check(`N1e the release notes name ${d.label}`, notes.indexOf(`*${d.label}*`) !== -1, d.label));
    }

    /* ---- A1 Host Details' Auth Failures ---- */
    const AUTH = '((sourcetype="sap:sapstartsrv" is_auth_event="true" auth_result="failure") OR (sourcetype="sap:hana:audit" action_category="Authentication" status!="SUCCESSFUL") OR (sourcetype="XmlWinEventLog" action="failure") OR ((sourcetype="linux_secure" OR sourcetype="linux_messages_syslog") ("authentication failure" OR "Failed password" OR "FAILED LOGIN") NOT sapuxuserchk))';
    const hdAgg = stanzas.logserv_hostdetails_aggregate || '';
    check('A1a the rollup arm', armOf(hdAgg, 'auth').indexOf(`\`sap_logserv_idx_macro\` ${AUTH} |`) !== -1, armOf(hdAgg, 'auth').slice(0, 300));
    check('A1b the backfill runs what the hourly search runs', hdAgg !== '' && hdAgg === stanzas.logserv_hostdetails_backfill);
    check('A2a the raw twin counts the same events',
        read(path.join(HOME, 'dashboards', 'HostDetails.tsx')).indexOf(`authFailures: \`\${W} ${AUTH} | stats count\`,`) !== -1);
    {
        const cross = read(path.join(HOME, 'dashboards', 'CrossStackAuthentication.tsx'));
        const m = /const ANY_AUTH_FAIL = '([^']*)'/.exec(cross);
        const parts = m ? (m[1].match(/\(sourcetype="[^)]*\)/g) || []) : [];
        check('A2b it starts from what Cross-Stack Authentication counts',
            parts.length === 3 && parts.every((p) => AUTH.indexOf(p) !== -1), parts.join(' | '));
    }
    check('A3a the old text is gone from the conf', SAVED.indexOf('OR EventCode=4625 OR status="UNSUCCESSFUL"') === -1);
    {
        // The volume arm reads every event, so naming sourcetypes in the auth arm must
        // not narrow the row: the folders the Data TA lists for it come from this.
        const sc = extractAggregateScope(hdAgg);
        check('A3b Host Details still reads all data', sc.sourcetypes.length === 0 && sc.tags.length === 0, JSON.stringify(sc));
        const M = '`sap_logserv_idx_macro`';
        const two = extractAggregateScope(`| union [search ${M} sourcetype="a" | stats count] [search ${M} | stats count] | fields x`);
        check('A3c an arm that reads every event makes the whole search unscoped', two.sourcetypes.length === 0, JSON.stringify(two));
        const text = extractAggregateScope(`| union [search ${M} sourcetype="a" | stats count] [search ${M} "text" | stats count] | fields x`);
        check('A3d an arm scoped by text does not', text.sourcetypes.join(',') === 'a', JSON.stringify(text));
        const named = extractAggregateScope(`| union [search ${M} sourcetype="a" | stats count] [search ${M} tag=dns | stats count] [search ${M} sourcetype IN ("b","c") | stats count] | fields x`);
        check('A3e arms that all name something keep their names',
            named.sourcetypes.join(',') === 'a,b,c' && named.tags.join(',') === 'dns', JSON.stringify(named));
        const noUnion = extractAggregateScope(`${M} sourcetype="a" | stats count`);
        check('A3f a search with no arms is read as before', noUnion.sourcetypes.join(',') === 'a', JSON.stringify(noUnion));
    }

    if (failures === 0) {
        console.log(`hostGrain consistency test: ${checks} checks OK (six rollups store host; an event counts once; an old row is zeroed when its hour is recounted; `
            + `the time bound removes only what the range removes; a filter never meets a row with no host; ${pageReads} page reads and ${savedReads} other reads add their rows up)`);
    } else {
        process.stderr.write(`hostGrain consistency test: ${failures} failure(s) of ${checks}\n`);
    }
    return failures;
};
