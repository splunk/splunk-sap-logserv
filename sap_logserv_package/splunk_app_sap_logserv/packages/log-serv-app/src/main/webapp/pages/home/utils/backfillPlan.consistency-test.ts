/**
 * Build-time consistency test for utils/backfillPlan.ts (App build 378,
 * design_impact.md finding F1): the Settings -> Dashboard Data backfill writes
 * the rows a single-pipeline union would write, for every rollup.
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  A. parseUnion is the splitter the panel always used (an oracle copy of the
 *     pre-378 function), on every stanza of the shipped savedsearches.conf.
 *  B. Only the two tails that combine rows across arms are staged - the
 *     Environment Topology nodes and inventory - and every other union tail is
 *     row-local, so no other rollup is dispatched differently. The staged tails'
 *     stats inputs are the expected fields and fit the stage.
 *  C. The stats parser refuses everything it cannot stage exactly: an
 *     order-dependent function (list, first, latest ...), eval(), options,
 *     wildcards, span=, too many fields, a field named like the stage's own.
 *  D. THE PROOF. A small row engine (this file; test-only) runs the shipped
 *     tails and the generated stage / combine searches over synthetic arm
 *     results, with a KV store that keeps the stage's values as strings, as the
 *     stage declares them:
 *       - the staged rows EQUAL a single-pipeline union over the same window,
 *         field for field, for the nodes (the Demo Gen overlaps the impact report
 *         names: gateway L= and ICM local IPs 10.186.72.120 / 10.186.72.92,
 *         gateway P= and Web Dispatcher clientip 10.186.64.15 / 10.186.68.33,
 *         HANA trace host = indexed host) over one window, over a 365-day window
 *         in monthly parts, and over the late-arrival run's several windows;
 *       - and for the inventory, where each entity gets its most recent SID
 *         over every arm's rows (build 379: of the SIDs seen in its newest
 *         hour, the one with the most events) and an exact tie writes no row,
 *         so the previous row stays;
 *       - the old per-arm dispatch, run by the same engine, gets those very rows
 *         wrong (the control: the engine can see the bug the fix removes);
 *       - arm completion order and the stage's read order change nothing;
 *       - the stage is empty after every part settles.
 *  E. The planner dispatches every row-local stanza EXACTLY as the pre-378
 *     buildWorkItems did (oracle copy), item for item, for a 30-day window, a
 *     365-day chunked window, a custom range and the late-arrival multi-window
 *     run; staged stanzas run part by part, each part's merge after all of its
 *     arms, every window unit once.
 *  F. The execution rules: a part is combined only when all its arms are done;
 *     a merge the panel stopped waiting for keeps its staged rows; a staged arm
 *     the panel stopped waiting for counts as failed; the KV queries.
 *  G. The registry's upgrade-note rows exist; the stage is in no rollup and no
 *     saved search reads, writes or trims it.
 *  H. Every staged row is accounted for (the build-378 review): a staged arm is done
 *     only when its job proves its result count with no ERROR message; the
 *     stage must hold exactly the rows the arms wrote before the combine and
 *     after it (retried for a KV Store warming up); the combine search fails on
 *     an empty read (`require`). Simulated in the row engine: a short, an empty
 *     and an over-read, a read that recovers, a combine whose read comes back
 *     empty, an arm with an ERROR message - none is reported done, none writes
 *     a short sum unnoticed; the clean run equals the union. The orphan sweep's
 *     clock is the server's.
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
const crypto = require('crypto');
const bp = require('./backfillPlan');
const bw = require('./backfillWindow');
const reg = require('../routes/rollupRegistry');

const DEFAULT_DIR = path.resolve(__dirname, '../../../../resources/splunk/default');

let bpFailures = 0;
let bpChecks = 0;
const check = (name: string, cond: boolean, detail: string): void => {
    bpChecks += 1;
    if (!cond) {
        bpFailures += 1;
        process.stderr.write(`FAIL ${name}: ${detail}\n`);
    }
};
const eq = (name: string, actual: unknown, expected: unknown): void =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const read = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/* ============================ the shipped conf ============================ */

const stanzaBodies = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    text.split(/^(?=\[)/m).forEach((chunk) => {
        const h = /^\[([^\]\n]+)\][ \t]*\n/.exec(chunk);
        if (h) out[h[1]] = chunk.slice(h[0].length);
    });
    return out;
};
const confLast = (body: string, key: string): string | null => {
    let v: string | null = null;
    body.split('\n').forEach((l) => {
        const m = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s?(.*)$`).exec(l);
        if (m) v = m[1];
    });
    return v;
};
const SS = stanzaBodies(read(path.join(DEFAULT_DIR, 'savedsearches.conf')));
const TF = stanzaBodies(read(path.join(DEFAULT_DIR, 'transforms.conf')));
const CO = stanzaBodies(read(path.join(DEFAULT_DIR, 'collections.conf')));
const searchOf = (stanza: string): string | null => (SS[stanza] ? confLast(SS[stanza], 'search') : null);

const NODES = 'logserv_topology_backfill_nodes';
const INVENTORY = 'logserv_topology_backfill_inventory';

/* ============================ A. parseUnion ============================ */

/* The pre-378 RollupBackfillPanel.tsx parseUnion, verbatim. */
const oldParseUnion = (spl: string): { arms: string[]; tail: string } => {
    const trimmed = spl.trim();
    if (!/^\|\s*union\b/.test(trimmed)) return { arms: [], tail: '' };
    const s = trimmed.replace(/^\|\s*union\s+/, '');
    const arms: string[] = [];
    let depth = 0;
    let start = -1;
    let rest = 0;
    let inQ = false;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '"') {
            let bs = 0;
            let j = i - 1;
            while (j >= 0 && s[j] === '\\') {
                bs += 1;
                j -= 1;
            }
            if (bs % 2 === 0) inQ = !inQ;
        } else if (!inQ) {
            if (ch === '[') {
                if (depth === 0) start = i + 1;
                depth += 1;
            } else if (ch === ']') {
                depth -= 1;
                if (depth === 0) {
                    arms.push(s.slice(start, i).trim());
                    rest = i + 1;
                }
            }
        }
    }
    return { arms, tail: s.slice(rest).trim() };
};

{
    const names = Object.keys(SS).filter((n) => searchOf(n) !== null);
    let unions = 0;
    names.forEach((n) => {
        const spl = searchOf(n) as string;
        const a = bp.parseUnion(spl);
        const b = oldParseUnion(spl);
        if (a.arms.length) unions += 1;
        eq(`A1 parseUnion unchanged on [${n}]`, a, b);
    });
    check('A2 the conf has union backfills to split', unions >= 25, `${unions} union stanzas`);
    const tricky = '| union [search x "a]b\\"c[" | eval y="\\\\"] [search z] | eval k=1';
    eq('A3 parseUnion: brackets inside quotes and an escaped backslash', bp.parseUnion(tricky), oldParseUnion(tricky));
    eq('A4 splitCommands: pipes inside quotes and brackets are not command breaks',
        bp.splitCommands('| stats count by a | eval b="x|y" | append [search c | head 1] | fields a'),
        ['stats count by a', 'eval b="x|y"', 'append [search c | head 1]', 'fields a']);
}

/* ======================= B. which tails are staged ======================= */

const unionBackfills: string[] = [];
([] as string[]).concat(...reg.ROLLUPS.map((d: any) => d.backfillStanzas)).forEach((s: string) => {
    const spl = searchOf(s);
    if (spl && bp.parseUnion(spl).arms.length > 0) unionBackfills.push(s);
});
{
    const forms: Record<string, any> = {};
    unionBackfills.forEach((s) => {
        forms[s] = bp.classifyTail(bp.parseUnion(searchOf(s) as string).tail);
    });
    const staged = unionBackfills.filter((s) => forms[s].kind === 'staged').sort();
    eq('B1 exactly the nodes and inventory tails combine rows across arms', staged, [INVENTORY, NODES]);
    const unsupported = unionBackfills.filter((s) => forms[s].kind === 'unsupported');
    check('B2 no shipped tail is refused', unsupported.length === 0,
        unsupported.map((s) => `${s}: ${forms[s].reason}`).join('; '));
    check('B3 every other union backfill is row-local (dispatched per arm, as before)',
        unionBackfills.filter((s) => staged.indexOf(s) === -1).every((s) => forms[s].kind === 'row_local'),
        unionBackfills.filter((s) => staged.indexOf(s) === -1 && forms[s].kind !== 'row_local').join(', '));
    check('B4 the conf still has its union backfills', unionBackfills.length >= 25, `${unionBackfills.length}`);
    const n = forms[NODES] || {};
    eq('B5 nodes: stats reads the counts, the endpoint and the hour',
        (n.inputs || []).slice().sort(), ['_time', 'canonical_kind', 'canonical_value', 'event_count', 'last_seen']);
    eq('B5 nodes: nothing before the stats', n.prefix, []);
    const v = forms[INVENTORY] || {};
    eq('B6 inventory: stats reads the event counts, the newest event, the SID and the endpoint',
        (v.inputs || []).slice().sort(), ['canonical_kind', 'canonical_value', 'last_seen', 'n', 'resolved_sid']);
    eq('B6 inventory: nothing before the stats', v.prefix, []);
    // Build 379: the choice runs AFTER the staged stats, so the combine search makes it over every arm's rows of
    // the part - the newest hour, then the most events, then one SID - and in that order.
    const rest7: string[] = v.rest || [];
    const steps7 = [
        /^eval last_hour\s*=\s*floor\(last_seen\/3600\)\*3600$/,
        /^eventstats max\(last_hour\) as newest_hour by canonical_value, canonical_kind$/,
        /^where last_hour\s*=\s*newest_hour$/,
        /^eventstats max\(n\) as top_n by canonical_value, canonical_kind$/,
        /^where n\s*=\s*top_n$/,
        /^stats values\(resolved_sid\) as resolved_sids by canonical_value, canonical_kind$/,
        /^where mvcount\(resolved_sids\)\s*=\s*1$/,
    ].map((re) => rest7.findIndex((c) => re.test(c)));
    check('B7 inventory: after its stats, the newest hour, then the most events, then the one-SID test, over the whole part',
        steps7.every((at, i) => at !== -1 && (i === 0 || at === steps7[i - 1] + 1)), JSON.stringify(rest7));
    check('B8 inventory is pinned to the fixed 30 days (one part)', reg.FIXED30_BACKFILL_STANZAS.has(INVENTORY), '');
    check('B9 nodes is chunked with the operator window', !reg.FIXED30_BACKFILL_STANZAS.has(NODES), '');
}

/* ======================= C. the stats parser ======================= */

{
    const ok = (s: string): string[] | null => {
        const r = bp.parseStatsInputs(s);
        return r.ok ? r.inputs : null;
    };
    eq('C1 functions then by-fields, each once',
        ok('stats sum(a) as a, max(b) as b by c, d, _time'), ['a', 'b', 'c', 'd', '_time']);
    eq('C2 bare count, space-separated functions', ok('stats count sum(x) by y'), ['x', 'y']);
    eq('C3 values() with AS, no by', ok('stats values(r) AS rs'), ['r']);
    eq('C4 a field used twice is staged once', ok('stats sum(a), max(a) by a'), ['a']);
    [
        'stats list(a) by b',
        'stats first(a) by b',
        'stats last(a) by b',
        'stats latest(a) by b',
        'stats earliest(a) by b',
        'stats mode(a) by b',
        'stats perc95(a) by b',
        'stats p50(a) by b',
        'stats sum(eval(a*2)) by b',
        'stats allnum=t sum(a) by b',
        'stats sum(a*) by b',
        'stats sum("a b") by c',
        'stats sum(a) by b span=1h',
        'stats sum(a) by',
        'stats by a',
        'stats sum(lsv_f1) by b',
        'stats dc(a) by b, c, d, e, f, g, h, i',
        'eventstats sum(a) by b',
        'stats sum(a, b) by c',
        'stats count by _key',
        'stats dc(_key) by a',
    ].forEach((s) => check(`C5 refused: ${s}`, ok(s) === null, JSON.stringify(bp.parseStatsInputs(s))));
    eq('C6 at most STAGE_SLOTS inputs', ok('stats dc(a) by b, c, d, e, f, g, h'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    eq('C7 classifyTail: row-local tail', bp.classifyTail('| eval a=1 | fields a | outputlookup append=true x').kind,
        'row_local');
    eq('C8 classifyTail: an overwriting outputlookup is refused',
        bp.classifyTail('| eval a=1 | outputlookup x').kind, 'unsupported');
    eq('C9 classifyTail: an overwriting outputlookup after the stats is refused too',
        bp.classifyTail('| stats count by a | outputlookup x').kind, 'unsupported');
    eq('C10 classifyTail: a combining command other than stats is refused',
        bp.classifyTail('| dedup a | outputlookup append=true x').kind, 'unsupported');
    const pre = bp.classifyTail('| eval k=lower(a) | where k!="x" | stats sum(n) by k | outputlookup append=true x');
    eq('C11 classifyTail: a row-local prefix runs per arm, before the stage', [pre.kind, pre.prefix, pre.inputs],
        ['staged', ['eval k=lower(a)', 'where k!="x"'], ['n', 'k']]);
    eq('C12 classifyTail: a write before the stats is refused',
        bp.classifyTail('| outputlookup append=true y | stats count by a | outputlookup append=true x').kind,
        'unsupported');
    // fillnull acts on one row at a time only with a field list: bare (or with a wildcard) it fills every
    // field ANY row has, so over a union arm A's rows get arm B's fields (proven in the row engine, D12).
    eq('C13 classifyTail: a bare fillnull is not row-local',
        bp.classifyTail('| fillnull value=0 | eval _key=k | fields _key, k, c, d | outputlookup append=true x').kind,
        'unsupported');
    eq('C13 ... nor before a stats (no staged prefix)',
        bp.classifyTail('| fillnull value=0 | stats sum(c) as c, count(d) as nd by k | outputlookup append=true x').kind,
        'unsupported');
    eq('C13 ... nor with a wildcard', bp.classifyTail('| fillnull value=0 c* | eval m=1 | outputlookup append=true x').kind,
        'unsupported');
    eq('C13 ... a field list is row-local', bp.classifyTail('| fillnull value=0 c d | eval m=1 | outputlookup append=true x').kind,
        'row_local');
    eq('C13 ... with no value= too', bp.classifyTail('| fillnull c | outputlookup append=true x').kind, 'row_local');
    const fl = bp.classifyTail('| fillnull value="n/a" c, d | stats sum(c) as c, count(d) as nd by k | outputlookup append=true x');
    eq('C13 ... and a listed fillnull is a staged prefix', [fl.kind, fl.prefix], ['staged', ['fillnull value="n/a" c, d']]);
    check('C13 the refusal says why', /fillnull/.test(String(bp.classifyTail('| fillnull | stats count by k | outputlookup append=true x').reason)),
        JSON.stringify(bp.classifyTail('| fillnull | stats count by k | outputlookup append=true x')));
}

/* ============================ D. the row engine ============================ */

type Val = string | number | boolean | string[] | null;
type Row = { [k: string]: Val };

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const toNum = (v: Val): number | null => {
    if (v === null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length === 1 ? toNum(v[0]) : null;
    return NUM_RE.test(v.trim()) ? Number(v) : null;
};
const toStr = (v: Val): string | null => {
    if (v === null) return null;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v;
};
const truthy = (v: Val): boolean => v === true || (typeof v === 'number' && v !== 0);
const unquote = (s: string): string => s.slice(1, -1).replace(/\\(["\\])/g, '$1');
/** `require` with no results: the search fails (its job ends FAILED). */
class RequireFailed extends Error {}

let ENGINE_NOW = 1790000000;

/* An SPL expression, compiled to a function of the row. Enough of eval for the
 * shipped tails; anything else throws, so a tail this engine cannot run fails
 * the test rather than passing it untested. */
const compileExpr = (src: string): ((r: Row) => Val) => {
    const toks: string[] = src.match(/"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|==|!=|<=|>=|[().,=<>+\-*/]|\S/g) || [];
    let p = 0;
    const peek = (): string | undefined => toks[p];
    const take = (t?: string): string => {
        const x = toks[p];
        if (t !== undefined && x !== t) throw new Error(`expected ${t} at "${toks.slice(p).join(' ')}" in ${src}`);
        p += 1;
        return x;
    };
    const cmpVals = (a: Val, b: Val): number | null => {
        const na = toNum(a);
        const nb = toNum(b);
        if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
        const sa = toStr(a);
        const sb = toStr(b);
        if (sa === null || sb === null) return null;
        return sa === sb ? 0 : sa < sb ? -1 : 1;
    };
    type F = (r: Row) => Val;
    let parseOr: () => F;
    const call = (name: string, args: F[]): F => {
        const fn = name.toLowerCase();
        if (fn === 'substr') {
            return (r) => {
                const s = toStr(args[0](r));
                const st = toNum(args[1](r));
                const ln = args[2] ? toNum(args[2](r)) : null;
                if (s === null || st === null) return null;
                return ln === null ? s.slice(st - 1) : s.slice(st - 1, st - 1 + ln);
            };
        }
        if (fn === 'sha1') {
            return (r) => {
                const s = toStr(args[0](r));
                return s === null ? null : crypto.createHash('sha1').update(s, 'utf8').digest('hex');
            };
        }
        if (fn === 'case') {
            return (r) => {
                for (let i = 0; i + 1 < args.length; i += 2) if (truthy(args[i](r))) return args[i + 1](r);
                return null;
            };
        }
        if (fn === 'if') return (r) => (truthy(args[0](r)) ? args[1](r) : args[2](r));
        if (fn === 'match') {
            return (r) => {
                const s = toStr(args[0](r));
                const re = toStr(args[1](r));
                return s === null || re === null ? null : new RegExp(re).test(s);
            };
        }
        if (fn === 'mvindex') {
            return (r) => {
                const v = args[0](r);
                const i = toNum(args[1](r));
                if (v === null || i === null) return null;
                const arr = Array.isArray(v) ? v : [toStr(v) as string];
                return i < arr.length ? arr[i] : null;
            };
        }
        if (fn === 'mvcount') {
            return (r) => {
                const v = args[0](r);
                return v === null ? null : Array.isArray(v) ? v.length : 1;
            };
        }
        if (fn === 'now') return () => ENGINE_NOW;
        if (fn === 'tonumber') return (r) => toNum(args[0](r));
        if (fn === 'floor') {
            // The inventory's hour: floor(last_seen/3600)*3600 (build 379).
            return (r) => {
                const n = toNum(args[0](r));
                return n === null ? null : Math.floor(n);
            };
        }
        if (fn === 'isnull') return (r) => args[0](r) === null;
        if (fn === 'isnotnull') return (r) => args[0](r) !== null;
        if (fn === 'null') return () => null;
        if (fn === 'coalesce') {
            return (r) => {
                for (const a of args) {
                    const v = a(r);
                    if (v !== null) return v;
                }
                return null;
            };
        }
        if (fn === 'lower') {
            return (r) => {
                const s = toStr(args[0](r));
                return s === null ? null : s.toLowerCase();
            };
        }
        throw new Error(`the row engine does not implement ${name}() (in ${src})`);
    };
    const parsePrimary = (): F => {
        const t = take();
        if (t === undefined) throw new Error(`unexpected end of ${src}`);
        if (t[0] === '"') {
            const s = unquote(t);
            return () => s;
        }
        if (/^\d/.test(t)) {
            const n = Number(t);
            return () => n;
        }
        if (t === '(') {
            const e = parseOr();
            take(')');
            return e;
        }
        if (/^[A-Za-z_]/.test(t)) {
            if (peek() === '(') {
                take('(');
                const args: F[] = [];
                if (peek() !== ')') {
                    args.push(parseOr());
                    while (peek() === ',') {
                        take(',');
                        args.push(parseOr());
                    }
                }
                take(')');
                return call(t, args);
            }
            return (r) => (Object.prototype.hasOwnProperty.call(r, t) ? r[t] : null);
        }
        throw new Error(`unexpected "${t}" in ${src}`);
    };
    const parseUnary = (): F => {
        if (peek() === '-') {
            take();
            const e = parseUnary();
            return (r) => {
                const n = toNum(e(r));
                return n === null ? null : -n;
            };
        }
        return parsePrimary();
    };
    const parseMul = (): F => {
        let l = parseUnary();
        while (peek() === '*' || peek() === '/') {
            const op = take();
            const a = l;
            const b = parseUnary();
            l = (r) => {
                const x = toNum(a(r));
                const y = toNum(b(r));
                if (x === null || y === null) return null;
                return op === '*' ? x * y : x / y;
            };
        }
        return l;
    };
    const parseAdd = (): F => {
        let l = parseMul();
        while (peek() === '+' || peek() === '-') {
            const op = take();
            const a = l;
            const b = parseMul();
            l = (r) => {
                const x = toNum(a(r));
                const y = toNum(b(r));
                if (x === null || y === null) return null;
                return op === '+' ? x + y : x - y;
            };
        }
        return l;
    };
    const parseConcat = (): F => {
        let l = parseAdd();
        while (peek() === '.') {
            take();
            const a = l;
            const b = parseAdd();
            l = (r) => {
                const x = toStr(a(r));
                const y = toStr(b(r));
                return x === null || y === null ? null : x + y;
            };
        }
        return l;
    };
    const parseCmp = (): F => {
        const l = parseConcat();
        const op = peek();
        if (op === '==' || op === '=' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
            take();
            const rr = parseConcat();
            return (r) => {
                const c = cmpVals(l(r), rr(r));
                if (c === null) return false;
                if (op === '==' || op === '=') return c === 0;
                if (op === '!=') return c !== 0;
                if (op === '<') return c < 0;
                if (op === '>') return c > 0;
                if (op === '<=') return c <= 0;
                return c >= 0;
            };
        }
        return l;
    };
    const parseNot = (): F => {
        if (peek() === 'NOT') {
            take();
            const e = parseNot();
            return (r) => !truthy(e(r));
        }
        return parseCmp();
    };
    const parseAnd = (): F => {
        let l = parseNot();
        while (peek() === 'AND') {
            take();
            const a = l;
            const b = parseNot();
            l = (r) => truthy(a(r)) && truthy(b(r));
        }
        return l;
    };
    parseOr = (): F => {
        let l = parseAnd();
        while (peek() === 'OR') {
            take();
            const a = l;
            const b = parseAnd();
            l = (r) => truthy(a(r)) || truthy(b(r));
        }
        return l;
    };
    const f = parseOr();
    if (p !== toks.length) throw new Error(`trailing "${toks.slice(p).join(' ')}" in ${src}`);
    return f;
};

/** Split at top-level commas (outside quotes and parentheses). */
const splitTopCommas = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let inQ = false;
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '"' && s[i - 1] !== '\\') inQ = !inQ;
        else if (!inQ && ch === '(') depth += 1;
        else if (!inQ && ch === ')') depth -= 1;
        else if (!inQ && depth === 0 && ch === ',') {
            out.push(s.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(s.slice(start).trim());
    return out.filter((x) => x.length > 0);
};

interface CollDef { fields: string[]; types: Record<string, string> }
/** A KV store: per collection, docs by _key. Values are cast to the declared
 *  field type (number or string; undeclared = string, as outputlookup sends
 *  them); only fields_list fields are kept. Reads come back in _key order -
 *  never in the order the arms wrote them. */
class Kv {
    defs: Record<string, CollDef> = {};

    data: Record<string, Map<string, Row>> = {};

    auto = 0;

    /** Collections whose reads come back EMPTY (a KV Store warming up after a
     *  restart): the rows are still there, a read does not see them. */
    blind = new Set<string>();

    define(name: string, def: CollDef): void {
        this.defs[name] = def;
        if (!this.data[name]) this.data[name] = new Map();
    }

    cast(coll: string, f: string, v: Val): Val {
        if (v === null) return null;
        const t = this.defs[coll].types[f] || 'string';
        if (Array.isArray(v)) return v.map((x) => String(x));
        if (t === 'number') return toNum(v);
        return toStr(v);
    }

    write(coll: string, rows: Row[], append: boolean): void {
        const def = this.defs[coll];
        if (!def) throw new Error(`no collection ${coll}`);
        if (!append) this.data[coll] = new Map();
        rows.forEach((r) => {
            const doc: Row = {};
            def.fields.forEach((f) => {
                if (f === '_key') return;
                const v = Object.prototype.hasOwnProperty.call(r, f) ? this.cast(coll, f, r[f]) : null;
                if (v !== null) doc[f] = v;
            });
            const k = r._key !== undefined && r._key !== null ? (toStr(r._key) as string) : `auto${String(++this.auto).padStart(8, '0')}`;
            doc._key = k;
            this.data[coll].set(k, doc);
        });
    }

    rows(coll: string): Row[] {
        if (this.blind.has(coll)) return [];
        const m = this.data[coll] || new Map();
        return Array.from(m.keys()).sort().map((k) => ({ ...(m.get(k) as Row) }));
    }

    remove(coll: string, pred: (r: Row) => boolean): void {
        const m = this.data[coll];
        Array.from(m.keys()).forEach((k) => {
            if (pred(m.get(k) as Row)) m.delete(k);
        });
    }
}

/** stats: order-free functions only, the same grammar parseStatsInputs takes. */
const runStats = (cmd: string, rows: Row[]): Row[] => {
    const body = cmd.replace(/^stats\s+/i, '');
    const parts = body.split(/\s+by\s+/i);
    const aggs = splitTopCommas(parts[0]).map((a) => {
        const m = /^([A-Za-z_]+)(?:\(([A-Za-z_][A-Za-z0-9_]*)\))?(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/i.exec(a.trim());
        if (!m) throw new Error(`the row engine cannot read the stats function "${a}"`);
        return { fn: m[1].toLowerCase(), arg: m[2] || null, as: m[3] || (m[2] ? `${m[1]}(${m[2]})` : m[1]) };
    });
    const by = parts[1] ? splitTopCommas(parts[1].replace(/\s+/g, ' ').split(' ').join(',')) : [];
    const groups = new Map<string, { key: Row; rows: Row[] }>();
    rows.forEach((r) => {
        const key: Row = {};
        for (const f of by) {
            const v = Object.prototype.hasOwnProperty.call(r, f) ? r[f] : null;
            if (v === null) return; // a row without a by-field is not counted
            key[f] = v;
        }
        const gk = JSON.stringify(by.map((f) => toStr(key[f])));
        if (!groups.has(gk)) groups.set(gk, { key, rows: [] });
        (groups.get(gk) as { rows: Row[] }).rows.push(r);
    });
    // Without a by-clause stats answers ONE row even over no rows (`stats count` -> 0), as Splunk does.
    if (by.length === 0 && groups.size === 0) groups.set('[]', { key: {}, rows: [] });
    const out: Row[] = [];
    Array.from(groups.keys()).sort().forEach((gk) => {
        const g = groups.get(gk) as { key: Row; rows: Row[] };
        const o: Row = { ...g.key };
        aggs.forEach((a) => {
            const vals: Val[] = a.arg ? g.rows.map((r) => (Object.prototype.hasOwnProperty.call(r, a.arg as string) ? r[a.arg as string] : null)).filter((v) => v !== null) : [];
            const flat: string[] = [];
            vals.forEach((v) => (Array.isArray(v) ? v.forEach((x) => flat.push(x)) : flat.push(toStr(v) as string)));
            const nums = flat.map((x) => toNum(x)).filter((x) => x !== null) as number[];
            let res: Val = null;
            if (a.fn === 'count' || a.fn === 'c') res = a.arg ? flat.length : g.rows.length;
            else if (a.fn === 'sum') res = nums.length ? nums.reduce((x, y) => x + y, 0) : null;
            else if (a.fn === 'max') res = nums.length ? Math.max(...nums) : null;
            else if (a.fn === 'min') res = nums.length ? Math.min(...nums) : null;
            else if (a.fn === 'avg' || a.fn === 'mean') res = nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : null;
            else if (a.fn === 'dc' || a.fn === 'distinct_count') res = new Set(flat).size;
            else if (a.fn === 'values') {
                const d = Array.from(new Set(flat)).sort();
                res = d.length ? d : null;
            } else throw new Error(`the row engine does not implement stats ${a.fn}()`);
            if (res !== null) o[a.as] = res;
        });
        out.push(o);
    });
    return out;
};

/** Run a pipeline (commands without leading pipes) over `input`, against `kv`. */
const runPipeline = (cmds: string[], input: Row[] | null, kv: Kv): Row[] => {
    let rows: Row[] = input ? input.map((r) => ({ ...r })) : [];
    cmds.forEach((cmd, i) => {
        const name = bp.commandName(cmd);
        const body = cmd.trim().slice(name.length).trim();
        if (name === 'inputlookup') {
            if (i !== 0) throw new Error('inputlookup must generate');
            const m = /^([\w.-]+)(?:\s+where\s+(.*))?$/.exec(body);
            if (!m) throw new Error(`cannot read ${cmd}`);
            const pred = m[2] ? compileExpr(m[2]) : null;
            rows = kv.rows(m[1]).filter((r) => (pred ? truthy(pred(r)) : true));
        } else if (name === 'eval') {
            const assigns = splitTopCommas(body).map((a) => {
                const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
                if (!m) throw new Error(`cannot read the eval assignment "${a}"`);
                return { f: m[1], e: compileExpr(m[2]) };
            });
            rows.forEach((r) => assigns.forEach((a) => {
                const v = a.e(r);
                if (v === null) delete r[a.f];
                else r[a.f] = v;
            }));
        } else if (name === 'rename') {
            const pairs = splitTopCommas(body).map((a) => {
                const m = /^(\S+)\s+as\s+(\S+)$/i.exec(a);
                if (!m) throw new Error(`cannot read the rename "${a}"`);
                return [m[1], m[2]];
            });
            rows.forEach((r) => pairs.forEach(([a, b]) => {
                if (Object.prototype.hasOwnProperty.call(r, a)) {
                    r[b] = r[a];
                    delete r[a];
                }
            }));
        } else if (name === 'fields') {
            const minus = body.startsWith('-');
            const list = splitTopCommas(body.replace(/^[-+]\s*/, ''));
            rows = rows.map((r) => {
                const o: Row = {};
                Object.keys(r).forEach((k) => {
                    const listed = list.indexOf(k) !== -1;
                    // `fields a, b` keeps the internal (underscore) fields - _time, _raw, _key ... -
                    // as Splunk does; only `fields - _x` removes one.
                    if (minus ? !listed : (listed || k.startsWith('_'))) o[k] = r[k];
                });
                return o;
            });
        } else if (name === 'where') {
            const pred = compileExpr(body);
            rows = rows.filter((r) => truthy(pred(r)));
        } else if (name === 'stats') {
            rows = runStats(cmd, rows);
        } else if (name === 'eventstats') {
            // The stats grammar, each group's results added to every row of the group: the rows keep their order
            // and their own fields, and a row without a by-field gets nothing, as in Splunk (the inventory tail,
            // build 379).
            const parts = body.split(/\s+by\s+/i);
            const by = parts[1] ? splitTopCommas(parts[1].replace(/\s+/g, ' ').split(' ').join(',')) : [];
            const groupOf = (r: Row): string => JSON.stringify(by.map((f) => toStr(r[f])));
            const agg = new Map<string, Row>();
            runStats(`stats ${body}`, rows).forEach((o) => agg.set(groupOf(o), o));
            rows.forEach((r) => {
                if (by.some((f) => !Object.prototype.hasOwnProperty.call(r, f) || r[f] === null)) return;
                const o = agg.get(groupOf(r));
                if (!o) return;
                Object.keys(o).forEach((k) => {
                    if (by.indexOf(k) === -1) r[k] = o[k];
                });
            });
        } else if (name === 'require') {
            if (rows.length === 0) throw new RequireFailed('the require command found no results');
        } else if (name === 'fillnull') {
            // Bare (no field list): every field any row has; with a list: those fields only.
            const vm = /^value\s*=\s*("(?:[^"\\]|\\.)*"|\S+)\s*/i.exec(body);
            const value: Val = vm ? (vm[1].startsWith('"') ? unquote(vm[1]) : vm[1]) : '0';
            const listed = (vm ? body.slice(vm[0].length) : body).split(/[\s,]+/).filter((x) => x.length > 0);
            const all = new Set<string>();
            rows.forEach((r) => Object.keys(r).forEach((k) => all.add(k)));
            const targets = listed.length ? listed : Array.from(all);
            rows.forEach((r) => targets.forEach((f) => {
                if (!Object.prototype.hasOwnProperty.call(r, f) || r[f] === null) r[f] = value;
            }));
        } else if (name === 'outputlookup') {
            const toks = body.split(/\s+/);
            const opts = toks.filter((t) => t.indexOf('=') !== -1);
            const coll = toks.filter((t) => t.indexOf('=') === -1);
            if (coll.length !== 1) throw new Error(`cannot read ${cmd}`);
            const append = opts.some((o) => /^append=(t|true|1)$/i.test(o));
            const keepEmpty = opts.some((o) => /^override_if_empty=(f|false|0)$/i.test(o));
            if (rows.length === 0 && !append && !keepEmpty) kv.write(coll[0], [], false);
            else kv.write(coll[0], rows, append);
        } else {
            throw new Error(`the row engine does not implement "${name}" (${cmd})`);
        }
    });
    return rows;
};

/* --------------------------- collections --------------------------- */

const collDef = (name: string): CollDef => {
    const tf = TF[name] || '';
    const fl = confLast(tf, 'fields_list');
    const types: Record<string, string> = {};
    (CO[name] || '').split('\n').forEach((l) => {
        const m = /^field\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\w+)/.exec(l);
        if (m) types[m[1]] = m[2];
    });
    return { fields: fl ? fl.split(',').map((x) => x.trim()) : [], types };
};
const STAGE_DEF: CollDef = {
    fields: Array.from(bp.STAGE_FIELDS_LIST as string[]),
    types: { [bp.STAGE_TIME_FIELD]: 'number' },
};
const newKv = (): Kv => {
    const kv = new Kv();
    kv.define('logserv_topology_nodes', collDef('logserv_topology_nodes'));
    kv.define('logserv_topology_inventory', collDef('logserv_topology_inventory'));
    kv.define(bp.STAGE_COLLECTION, STAGE_DEF);
    return kv;
};
check('D0 the final collections are defined in transforms.conf', collDef('logserv_topology_nodes').fields.length > 5
    && collDef('logserv_topology_inventory').fields.length > 3, 'fields_list missing');

/* ------------------------ synthetic arm results ------------------------ */

const armIdentity = (arm: string): { field: string; kind: string } => {
    const nodeM = /rename\s+(\w+)\s+as\s+canonical_value[\s\S]*?eval\s+canonical_kind\s*=\s*"(\w+)"/.exec(arm);
    if (nodeM) return { field: nodeM[1], kind: nodeM[2] };
    const invM = /eval\s+canonical_value\s*=\s*(\w+),\s*canonical_kind\s*=\s*"(\w+)"/.exec(arm);
    if (invM) return { field: invM[1], kind: invM[2] };
    return { field: '?', kind: 'ip' };
};

/* Per node arm (by the field it renames and the kind it emits): value -> count
 * in an hour. The overlaps are the Demo Gen ones the impact report names. */
const NODE_DATA: Record<string, Array<[string, number]>> = {
    'sap_sid:sid': [['XCI', 40], ['XCS', 3]],
    'local_ip:ip': [['10.186.72.120', 7], ['10.186.72.92', 3], ['10.0.0.1', 1]],
    'icm_local_ip:ip': [['10.186.72.120', 5], ['10.186.72.92', 4]],
    'hana_host:host': [['hec53v052427', 9]],
    'host:host': [['hec53v052427', 12], ['hec53v013858', 2]],
    'clientip:ip': [['10.186.64.15', 20], ['10.186.68.33', 1]],
    'peer_ip:ip': [['10.186.64.15', 11], ['10.186.68.33', 6]],
    'client_ip:ip': [['10.186.64.15', 3]],
    // SAP Router (item e): the router host's own node, and the CONNECT TO target IPs - normally an
    // application server's gateway / ICM address, so 10.186.72.120 is reported by three arms.
    'host:saprouter': [['saprouter01', 25]],
    'saprouter_target_ip:ip': [['10.186.72.120', 6], ['10.186.72.200', 4]],
};
const nodeRows = (arm: string, armNo: number, hours: number[]): Row[] => {
    const id = armIdentity(arm);
    const data = NODE_DATA[`${id.field}:${id.kind}`]
        // an arm this test does not know (a new one): its own value, plus the
        // most-shared IP when it emits IPs - the case a new arm makes worse.
        || ([[`gen-${armNo}`, armNo] as [string, number]].concat(id.kind === 'ip' ? [['10.186.72.120', 2]] : []));
    const out: Row[] = [];
    hours.forEach((h, hi) => {
        data.forEach(([v, n]) => {
            out.push({
                canonical_value: v, canonical_kind: id.kind, _time: h,
                event_count: n + hi, last_seen: h + 1000 + 37 * armNo + n + 0.25,
            });
        });
    });
    return out;
};
/* Per inventory arm (by the field it maps and the kind it emits): its raw events, as [value, SID, events, newest
 * event]. invRows runs the arm's OWN commands from its stats on over them (the base search and its filters are the
 * index's work), so what each arm hands the tail - the event count and the newest event per entity and SID (build
 * 379) - comes from the shipped arm text. INV_OLD is an older hour of the 30-day window, INV_NEW its newest (the
 * fixed window ends at NOW_MS, 2026-10-09T23:00Z). The cases:
 *   10.186.72.120  gateway XCJ x3 in INV_NEW, ICM XCI x50 in INV_OLD: the newest hour wins over more events;
 *   10.186.72.92   gateway, ICM and SAP Router all XCI: arms that agree;
 *   10.186.72.150  ICM XCA x9 half a second before INV_NEW, XCB x1 at INV_NEW itself: the hour is floor();
 *   10.0.0.1       gateway XCS x2 and SAP Router XCJ x2, both in INV_NEW: an exact tie, so no row (the old row stays);
 *   hec53v052427   HANA trace and host both XCL: arms that agree;
 *   dewdfm7096     HANA trace XCL x5 + host XCL x5 against host XCJ x8, all in INV_NEW: the counts add up over the
 *                  arms (the host arm alone would pick XCJ);
 *   hec53v014018   host XCP x500 and W3V x13 in INV_NEW, a W3V line the hour's last event: the most events, not the
 *                  latest event (the Demo Gen XCP host and its stray W3V monitoring lines);
 *   hec53v013858   host XCS x2 in INV_OLD only: the entity's own most recent hour, not the window's;
 *   hec53v020202   host XCA x4 and XCB x4 in INV_NEW, XCC x100 in INV_OLD: a tie in the newest hour, so no row, and
 *                  the older SID with more events does not win either. */
type InvEvents = Array<[string, string, number, number]>;
const INV_OLD = Date.UTC(2026, 8, 20, 10) / 1000;
const INV_NEW = Date.UTC(2026, 9, 9, 21) / 1000;
const INV_DATA: Record<string, InvEvents> = {
    'local_ip:ip': [['10.186.72.120', 'XCJ', 3, INV_NEW + 600], ['10.186.72.92', 'XCI', 4, INV_NEW + 100],
        ['10.0.0.1', 'XCS', 2, INV_NEW + 300]],
    'icm_local_ip:ip': [['10.186.72.120', 'XCI', 50, INV_OLD + 1200], ['10.186.72.92', 'XCI', 2, INV_OLD + 30],
        ['10.186.72.150', 'XCA', 9, INV_NEW - 0.5], ['10.186.72.150', 'XCB', 1, INV_NEW]],
    'hana_host:host': [['hec53v052427', 'XCL', 9, INV_NEW + 50], ['dewdfm7096', 'XCL', 5, INV_NEW + 500]],
    'host:host': [['hec53v052427', 'XCL', 12, INV_NEW + 60], ['dewdfm7096', 'XCL', 5, INV_NEW + 400],
        ['dewdfm7096', 'XCJ', 8, INV_NEW + 3500], ['hec53v014018', 'XCP', 500, INV_NEW + 60],
        ['hec53v014018', 'W3V', 13, INV_NEW + 3590.75], ['hec53v013858', 'XCS', 2, INV_OLD + 10],
        ['hec53v020202', 'XCA', 4, INV_NEW + 10], ['hec53v020202', 'XCB', 4, INV_NEW + 20],
        ['hec53v020202', 'XCC', 100, INV_OLD + 10]],
    // SAP Router (item e, the sapms<SID> target arm): agrees on 10.186.72.92, ties the gateway on 10.0.0.1.
    'saprouter_target_ip:ip': [['10.186.72.92', 'XCI', 1, INV_NEW + 200], ['10.0.0.1', 'XCJ', 2, INV_NEW + 3000]],
};
const invEventsOf = (arm: string, armNo: number): InvEvents => {
    const id = armIdentity(arm);
    return INV_DATA[`${id.field}:${id.kind}`] || [[`gen-${armNo}`, 'XCI', 1, INV_NEW]];
};
const invRows = (arm: string, armNo: number): Row[] => {
    const id = armIdentity(arm);
    // The SAP Router arm groups by the SID its target's message server names; the others by sap_sid.
    const sidField = /\bsaprouter_target_sid=\*/.test(arm) ? 'saprouter_target_sid' : 'sap_sid';
    const events: Row[] = [];
    invEventsOf(arm, armNo).forEach(([v, s, n, t]) => {
        // n events, the newest at t, the others up to n - 1 seconds earlier and not in time order.
        for (let k = 0; k < n; k += 1) events.push({ [id.field]: v, [sidField]: s, _time: t - ((k * 7) % n) });
    });
    const cmds: string[] = bp.splitCommands(arm);
    const at = cmds.findIndex((c) => bp.commandName(c) === 'stats');
    if (at === -1) throw new Error(`the inventory arm has no stats: ${arm}`);
    return runPipeline(cmds.slice(at), events, newKv());
};

/* ------------------------------ the runs ------------------------------ */

const inWindow = (r: Row, e: number, l: number): boolean => {
    if (!Object.prototype.hasOwnProperty.call(r, '_time')) return true;
    const t = toNum(r._time) as number;
    return t >= e && t < l;
};

/** The single-pipeline union: every arm's rows (inside the windows), one tail. */
const runUnion = (spl: string, rowsByArm: Row[][], windows: Array<{ earliest: number; latest: number }>, kv: Kv): void => {
    const { tail } = bp.parseUnion(spl);
    windows.forEach((w) => {
        const all: Row[] = [];
        rowsByArm.forEach((rs) => rs.forEach((r) => {
            if (inWindow(r, w.earliest, w.latest)) all.push(r);
        }));
        runPipeline(bp.splitCommands(tail), all, kv);
    });
};

/** The pre-378 per-arm dispatch: `<arm> <tail>` per arm, in `order`. */
const runOldPerArm = (spl: string, rowsByArm: Row[][], windows: Array<{ earliest: number; latest: number }>,
    kv: Kv, order: number[]): void => {
    const { tail } = bp.parseUnion(spl);
    order.forEach((i) => windows.forEach((w) => {
        runPipeline(bp.splitCommands(tail), rowsByArm[i].filter((r) => inWindow(r, w.earliest, w.latest)), kv);
    }));
};

/** The 378 plan, executed: stage items through the engine (the arm's own
 *  search replaced by its synthetic result), then each part's merge, then the
 *  part's stage rows deleted. `reverse` finishes the arms of a part in reverse. */
const runPlanned = (stanza: string, spl: string, rowsByArm: Row[][], wins: any[], fixed30: any, kv: Kv,
    reverse: boolean): { items: any[]; parts: number } => {
    const { arms } = bp.parseUnion(spl);
    let n = 0;
    const items = bp.planRollupItems([{ stanza, spl }], wins, fixed30,
        (s: string) => reg.FIXED30_BACKFILL_STANZAS.has(s), () => `rtest.${++n}`);
    const byPart = new Map<string, any[]>();
    items.forEach((it: any) => {
        if (!it.part) return;
        if (!byPart.has(it.part)) byPart.set(it.part, []);
        (byPart.get(it.part) as any[]).push(it);
    });
    byPart.forEach((its, part) => {
        const stages = its.filter((x: any) => x.kind === 'stage');
        (reverse ? stages.slice().reverse() : stages).forEach((it: any) => {
            const arm = arms[it.armIndex - 1];
            if (!it.spl.startsWith(`${arm} | `)) throw new Error(`stage item does not start with its arm (${part})`);
            const rows = rowsByArm[it.armIndex - 1].filter((r) => inWindow(r, it.earliest, it.latest));
            runPipeline(bp.splitCommands(it.spl.slice(arm.length + 3)), rows, kv);
        });
        const merges = its.filter((x: any) => x.kind === 'merge');
        if (merges.length !== 1) throw new Error(`part ${part} has ${merges.length} merges`);
        runPipeline(bp.splitCommands(merges[0].spl), null, kv);
        kv.remove(bp.STAGE_COLLECTION, (r) => r[bp.STAGE_PART_FIELD] === part);
    });
    return { items, parts: byPart.size };
};

const NOW_MS = Date.UTC(2026, 9, 9, 23, 0, 0); // 2026-10-09T23:00Z
const win = (c: any): any => {
    const r = bw.resolveWindow(c, NOW_MS);
    if (!r.ok) throw new Error(r.error);
    return r.window;
};
const W30 = win({ kind: 'preset', days: 30 });
const W365 = win({ kind: 'preset', days: 365 });
const FIXED30 = W30;
const H = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const nodesSpl = searchOf(NODES);
const invSpl = searchOf(INVENTORY);
check('D1 the nodes and inventory backfills are in the conf', !!nodesSpl && !!invSpl, '');

const finalRows = (kv: Kv, coll: string): Record<string, Row> => {
    const o: Record<string, Row> = {};
    kv.rows(coll).forEach((r) => {
        o[r._key as string] = r;
    });
    return o;
};
const diffKeys = (a: Record<string, Row>, b: Record<string, Row>): string[] => {
    const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
    return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
};
const nodeKey = (kind: string, value: string, bucket: number): string =>
    `${crypto.createHash('sha1').update(`${kind}:${value}`, 'utf8').digest('hex').slice(0, 16)}:${bucket}`;

if (nodesSpl && invSpl) {
    try {
        const nArms = bp.parseUnion(nodesSpl).arms as string[];
        ENGINE_NOW = Math.floor(NOW_MS / 1000);

        /* D2-D4: one 30-day window. */
        const hours30 = [H('2026-09-20T10:00:00Z'), H('2026-09-20T11:00:00Z'), H('2026-10-09T21:00:00Z')];
        const rows30 = nArms.map((a, i) => nodeRows(a, i + 1, hours30));
        const kvU = newKv();
        runUnion(nodesSpl, rows30, [W30], kvU);
        const kvS = newKv();
        const run30 = runPlanned(NODES, nodesSpl, rows30, [W30], FIXED30, kvS, false);
        const U = finalRows(kvU, 'logserv_topology_nodes');
        const S = finalRows(kvS, 'logserv_topology_nodes');
        check('D2 nodes, one window: the staged rows equal the single-pipeline union, field for field',
            Object.keys(U).length > 10 && diffKeys(U, S).length === 0,
            `${Object.keys(U).length} union rows; differing keys ${JSON.stringify(diffKeys(U, S).slice(0, 4))}`);
        eq('D2 nodes, one window: one part', run30.parts, 1);
        const h1 = hours30[0];
        const k120 = nodeKey('ip', '10.186.72.120', h1);
        const k15 = nodeKey('ip', '10.186.64.15', h1);
        const k427 = nodeKey('host', 'hec53v052427', h1);
        const known = (f: string): boolean => nArms.some((a) => `${armIdentity(a).field}:${armIdentity(a).kind}` === f);
        const extra120 = nArms.filter((a) => !NODE_DATA[`${armIdentity(a).field}:${armIdentity(a).kind}`]
            && armIdentity(a).kind === 'ip').length * 2;
        check('D3 the SAP Router arms (item e) are in the nodes backfill',
            known('host:saprouter') && known('saprouter_target_ip:ip'), JSON.stringify(nArms.map((a) => armIdentity(a))));
        check('D3 the gateway L=, ICM local and SAP Router target IP is one row whose count is the sum',
            !!S[k120] && toNum(S[k120].event_count) === 7 + 5 + 6 + extra120 && known('local_ip:ip')
            && known('icm_local_ip:ip'), JSON.stringify(S[k120]));
        check('D3 the gateway P=, Web Dispatcher and HANA client IP is one row whose count is the sum',
            !!S[k15] && toNum(S[k15].event_count) === 20 + 11 + 3, JSON.stringify(S[k15]));
        check('D3 the HANA trace host and the indexed host are one row', !!S[k427] && toNum(S[k427].event_count) === 9 + 12,
            JSON.stringify(S[k427]));
        const lastSeen120 = Math.max(...nArms.map((a, i) => {
            const r = rows30[i].find((x) => x.canonical_value === '10.186.72.120' && x._time === h1);
            return r ? (toNum(r.last_seen) as number) : -1;
        }));
        check('D3 last_seen is the latest over the arms', !!S[k120] && toNum(S[k120].last_seen) === lastSeen120,
            `${JSON.stringify(S[k120])} vs ${lastSeen120}`);

        /* The control: the pre-378 per-arm dispatch writes the overlaps wrong. */
        const kvO = newKv();
        runOldPerArm(nodesSpl, rows30, [W30], kvO, nArms.map((_, i) => i));
        const O = finalRows(kvO, 'logserv_topology_nodes');
        const wrong = diffKeys(U, O);
        check('D4 control: the old per-arm dispatch undercounts exactly the shared rows',
            wrong.indexOf(k120) !== -1 && wrong.indexOf(k15) !== -1 && wrong.indexOf(k427) !== -1
            && toNum(O[k120].event_count) !== toNum(U[k120].event_count),
            `wrong keys ${wrong.length}: ${JSON.stringify(O[k120])}`);
        const unique = nodeKey('ip', '10.0.0.1', h1);
        check('D4 control: rows only one arm reports are right either way',
            wrong.indexOf(unique) === -1 && !!O[unique], JSON.stringify(O[unique]));

        /* D5: arm completion order and read order change nothing. */
        const kvR = newKv();
        runPlanned(NODES, nodesSpl, rows30, [W30], FIXED30, kvR, true);
        check('D5 nodes: arms finishing in reverse give the same rows',
            diffKeys(U, finalRows(kvR, 'logserv_topology_nodes')).length === 0, '');
        eq('D5 the stage is empty once every part has settled', kvS.rows(bp.STAGE_COLLECTION).length, 0);

        /* D6: a 365-day window in monthly parts. */
        const hours365 = [H('2025-10-15T03:00:00Z'), H('2025-12-31T23:00:00Z'), H('2026-01-01T00:00:00Z'),
            H('2026-03-31T23:00:00Z'), H('2026-06-10T00:00:00Z'), H('2026-10-09T22:00:00Z')];
        const rows365 = nArms.map((a, i) => nodeRows(a, i + 1, hours365));
        const kvU2 = newKv();
        runUnion(nodesSpl, rows365, [W365], kvU2);
        const kvS2 = newKv();
        const run365 = runPlanned(NODES, nodesSpl, rows365, [W365], FIXED30, kvS2, false);
        const U2 = finalRows(kvU2, 'logserv_topology_nodes');
        check('D6 nodes, 365 days in monthly parts: the staged rows equal the union',
            Object.keys(U2).length > 30 && diffKeys(U2, finalRows(kvS2, 'logserv_topology_nodes')).length === 0,
            `${diffKeys(U2, finalRows(kvS2, 'logserv_topology_nodes')).length} differing of ${Object.keys(U2).length}`);
        eq('D6 one part per monthly chunk', run365.parts, bw.planChunks(W365.earliest, W365.latest).length);

        /* D7: the late-arrival run - several windows. */
        const lateWins = [win({ kind: 'custom', from: '2026-09-02', to: '2026-09-03' }),
            win({ kind: 'custom', from: '2026-09-20', to: '2026-09-20' }),
            win({ kind: 'custom', from: '2026-10-09', to: '2026-10-09' })];
        const hoursLate = [H('2026-09-02T05:00:00Z'), H('2026-09-03T23:00:00Z'), H('2026-09-20T10:00:00Z'),
            H('2026-09-21T10:00:00Z'), H('2026-10-09T21:00:00Z')];
        const rowsLate = nArms.map((a, i) => nodeRows(a, i + 1, hoursLate));
        const kvU3 = newKv();
        runUnion(nodesSpl, rowsLate, lateWins, kvU3);
        const kvS3 = newKv();
        const runLate = runPlanned(NODES, nodesSpl, rowsLate, lateWins, FIXED30, kvS3, false);
        const U3 = finalRows(kvU3, 'logserv_topology_nodes');
        check('D7 nodes, the late-arrival windows: the staged rows equal the union over the same windows',
            lateWins.length === 3 && Object.keys(U3).length > 10
            && diffKeys(U3, finalRows(kvS3, 'logserv_topology_nodes')).length === 0,
            `${diffKeys(U3, finalRows(kvS3, 'logserv_topology_nodes')).length} differing`);
        eq('D7 one part per window', runLate.parts, 3);
        check('D7 an hour outside the windows is written by neither',
            !U3[nodeKey('ip', '10.186.72.120', H('2026-09-21T10:00:00Z'))], '');

        /* D8: the inventory - one fixed 30-day part; each entity gets its most recent SID (build 379): the SIDs of
         * its newest hour, then the most events over all arms; an exact tie writes no row (INV_DATA's cases). */
        const iArms = bp.parseUnion(invSpl).arms as string[];
        const irows = iArms.map((a, i) => invRows(a, i + 1));
        // The previous run's row for the address that now ties: a tie writes nothing, so this row must stay.
        const OLD_AT = 1789000000;
        const seeded = (): Kv => {
            const kv = newKv();
            kv.write('logserv_topology_inventory', [{ _key: '10.0.0.1', canonical_value: '10.0.0.1', canonical_kind: 'ip',
                resolved_sid: 'XCS', updated_at: OLD_AT }], true);
            return kv;
        };
        const kvIU = seeded();
        runUnion(invSpl, irows, [FIXED30], kvIU);
        const kvIS = seeded();
        const runInv = runPlanned(INVENTORY, invSpl, irows, [W365], FIXED30, kvIS, false);
        const IU = finalRows(kvIU, 'logserv_topology_inventory');
        const IS = finalRows(kvIS, 'logserv_topology_inventory');
        const sidOf = (r: Row | undefined): Val => (r ? r.resolved_sid : null);
        check('D8 inventory: the staged rows equal the union', Object.keys(IU).length >= 8 && diffKeys(IU, IS).length === 0,
            `${JSON.stringify(Object.keys(IU))} vs ${JSON.stringify(Object.keys(IS))}`);
        eq('D8 inventory: one part (pinned to the fixed 30 days whatever the window)', runInv.parts, 1);
        check('D8 inventory: the SAP Router target arm (item e) is in the inventory backfill',
            iArms.some((a) => `${armIdentity(a).field}:${armIdentity(a).kind}` === 'saprouter_target_ip:ip'),
            JSON.stringify(iArms.map((a) => armIdentity(a))));
        const pairsOf = (rs: Row[]): string[] => rs.map((r) => `${toStr(r.canonical_value)}=${toStr(r.resolved_sid)}`).sort();
        check('D8 inventory: every arm hands the tail each (entity, SID) it saw, with its count and newest event - no arm'
            + ' decides alone', iArms.length === 5 && iArms.every((a, i) => JSON.stringify(pairsOf(irows[i]))
                === JSON.stringify(invEventsOf(a, i + 1).map(([v, s]) => `${v}=${s}`).sort())
                && irows[i].every((r) => toNum(r.n) !== null && toNum(r.last_seen) !== null)),
            JSON.stringify(irows));
        eq('D8 inventory: the newest hour wins over more events in an older hour (10.186.72.120)', sidOf(IS['10.186.72.120']), 'XCJ');
        eq('D8 inventory: the hour is floor() - half a second before the hour belongs to the hour before (10.186.72.150)',
            sidOf(IS['10.186.72.150']), 'XCB');
        eq('D8 inventory: the counts add up over the arms (dewdfm7096: XCL 5 + 5 over XCJ 8)', sidOf(IS.dewdfm7096), 'XCL');
        eq('D8 inventory: the most events win, not the latest event (hec53v014018: XCP 500 over W3V 13)',
            sidOf(IS.hec53v014018), 'XCP');
        eq('D8 inventory: the most recent hour is the entity\'s own, not the window\'s (hec53v013858)', sidOf(IS.hec53v013858), 'XCS');
        check('D8 inventory: an exact tie writes no row - the previous row stays as it was (10.0.0.1)',
            sidOf(IS['10.0.0.1']) === 'XCS' && toNum(IS['10.0.0.1'].updated_at) === OLD_AT, JSON.stringify(IS['10.0.0.1']));
        check('D8 inventory: a tie in the newest hour writes no row, and the older SID with more events does not win (hec53v020202)',
            !IS.hec53v020202, JSON.stringify(IS.hec53v020202));
        check('D8 inventory: arms that agree give the SID', sidOf(IS['10.186.72.92']) === 'XCI' && sidOf(IS.hec53v052427) === 'XCL',
            JSON.stringify([IS['10.186.72.92'], IS.hec53v052427]));
        check('D8 inventory: every row written now carries the run\'s updated_at',
            Object.keys(IS).filter((k) => k !== '10.0.0.1').every((k) => toNum(IS[k].updated_at) === ENGINE_NOW), JSON.stringify(IS));
        // The control: the old per-arm dispatch runs the tail once per arm, so the last arm decides - another SID than
        // the union for an address an older arm saw more recently, for a host whose counts add up over two arms, and
        // a row over the tie's previous one.
        const kvIO = seeded();
        runOldPerArm(invSpl, irows, [FIXED30], kvIO, iArms.map((_, i) => i));
        const IO = finalRows(kvIO, 'logserv_topology_inventory');
        const wrongIO = ['10.186.72.120', 'dewdfm7096', '10.0.0.1'].filter((k) => sidOf(IO[k]) !== sidOf(IS[k]));
        check('D9 control: the old per-arm dispatch writes other SIDs than the union (the last arm wins)',
            wrongIO.length === 3 && sidOf(IO['10.186.72.120']) === 'XCI' && sidOf(IO.dewdfm7096) === 'XCJ'
            && sidOf(IO['10.0.0.1']) === 'XCJ',
            `${JSON.stringify(wrongIO)}: ${JSON.stringify([IO['10.186.72.120'], IO.dewdfm7096, IO['10.0.0.1']])}`);

        /* D10: the stage keeps strings; the combine reads only its own part. */
        const kvP = newKv();
        const items = bp.planRollupItems([{ stanza: NODES, spl: nodesSpl }], [W365], FIXED30, () => false,
            ((): (() => string) => {
                let k = 0;
                return () => `rtest.${++k}`;
            })());
        const firstStage = items.find((x: any) => x.kind === 'stage');
        runPipeline(bp.splitCommands(firstStage.spl.slice(nArms[firstStage.armIndex - 1].length + 3)),
            rows365[firstStage.armIndex - 1].filter((r) => inWindow(r, firstStage.earliest, firstStage.latest)), kvP);
        const staged = kvP.rows(bp.STAGE_COLLECTION);
        check('D10 a staged row holds only the part, the time and the slots, as strings',
            staged.length > 0 && staged.every((r) => Object.keys(r).every((k) => (bp.STAGE_FIELDS_LIST as string[]).indexOf(k) !== -1)
                && typeof r[bp.STAGE_TIME_FIELD] === 'number'
                && (bp.STAGE_SLOT_FIELDS as string[]).every((s) => r[s] === undefined || typeof r[s] === 'string')),
            JSON.stringify(staged[0]));
        // A stray row of another part must not reach this part's combine.
        kvP.write(bp.STAGE_COLLECTION, [{ lsv_part: 'rother.1', lsv_staged_at: 1, lsv_f1: '999999', lsv_f2: '1',
            lsv_f3: 'ip', lsv_f4: '10.186.72.120', lsv_f5: String(h1) }], true);
        const mergeIt = items.find((x: any) => x.kind === 'merge' && x.part === firstStage.part);
        runPipeline(bp.splitCommands(mergeIt.spl), null, kvP);
        check('D10 the combine reads its own part only', Object.values(finalRows(kvP, 'logserv_topology_nodes'))
            .every((r) => toNum(r.event_count) !== 999999), '');

        /* D11: an arm (and the tail's prefix) that sets _key - `fields <list>` keeps underscore fields, so the
         * stage write drops _key itself; otherwise arm b's staged row would overwrite arm a's (same key). */
        const keySpl = '| union [search a | eval _key="same"] [search b | eval _key="same"] | eval _key=k'
            + ' | stats sum(n) as n by k | eval _key=k | fields _key, k, n | outputlookup append=true logserv_k';
        const kRows: Row[][] = [[{ _key: 'same', k: 'x', n: 1, _time: h1 }, { _key: 'same', k: 'y', n: 5, _time: h1 }],
            [{ _key: 'same', k: 'x', n: 2, _time: h1 }]];
        const kvKU = newKv();
        const kvKS = newKv();
        [kvKU, kvKS].forEach((kv) => kv.define('logserv_k', { fields: ['_key', 'k', 'n'], types: { n: 'number' } }));
        runUnion(keySpl, kRows, [W30], kvKU);
        runPlanned('k', keySpl, kRows, [W30], FIXED30, kvKS, false);
        const KU = finalRows(kvKU, 'logserv_k');
        check('D11 an arm that sets _key: the staged rows still equal the union (x = 1 + 2)',
            !!KU.x && toNum(KU.x.n) === 3 && diffKeys(KU, finalRows(kvKS, 'logserv_k')).length === 0,
            `${JSON.stringify(KU)} vs ${JSON.stringify(finalRows(kvKS, 'logserv_k'))}`);

        /* D12: why a bare fillnull is not row-local (C13). */
        const fA: Row[] = [{ k: 'x', c: 1 }];
        const fB: Row[] = [{ k: 'x', d: 2 }];
        const perArm = (cmds: string[]): Row[] => runPipeline(cmds.slice(1),
            runPipeline([cmds[0]], fA, newKv()).concat(runPipeline([cmds[0]], fB, newKv())), newKv());
        const bare = bp.splitCommands('| fillnull value=0 | stats count(d) as nd, values(d) as dv by k');
        const listedFill = bp.splitCommands('| fillnull value=0 c | stats count(d) as nd, values(d) as dv by k');
        const bareU = runPipeline(bare, fA.concat(fB), newKv());
        check('D12 a bare fillnull per arm is not the union (arm a gets no d, so it is refused)',
            JSON.stringify(bareU) !== JSON.stringify(perArm(bare)), `${JSON.stringify(bareU)} vs ${JSON.stringify(perArm(bare))}`);
        const listedU = runPipeline(listedFill, fA.concat(fB), newKv());
        check('D12 ... a fillnull with a field list per arm is the union', JSON.stringify(listedU) === JSON.stringify(perArm(listedFill)),
            `${JSON.stringify(listedU)} vs ${JSON.stringify(perArm(listedFill))}`);
    } catch (e) {
        check('D the simulation ran', false, String(e && (e as any).stack ? (e as any).stack : e));
    }
}

/* ======================= E. the plan versus the old algorithm ======================= */

/* The pre-378 buildWorkItems expansion, verbatim but for the fetch. */
const oldPlan = (loaded: Array<{ stanza: string; spl: string | null }>, wins: any[], fixed30: any): any[] => {
    const items: any[] = [];
    const arms: Array<{ spl: string; wins: any[]; chunk: boolean }> = [];
    loaded.forEach(({ stanza, spl }) => {
        if (!spl) return;
        const pinned = reg.FIXED30_BACKFILL_STANZAS.has(stanza);
        const w = pinned ? [fixed30] : wins;
        const { arms: parsed, tail } = oldParseUnion(spl);
        if (parsed.length === 0) arms.push({ spl, wins: w, chunk: !pinned });
        else parsed.forEach((a) => arms.push({ spl: `${a} ${tail}`, wins: w, chunk: !pinned }));
    });
    if (arms.length === 0) {
        items.push({ spl: '', armIndex: 1, armCount: 1, earliest: wins[0].earliest, latest: wins[0].latest, chunkLabel: '' });
        return items;
    }
    arms.forEach((arm, i) => {
        arm.wins.forEach((w) => {
            const chunks = arm.chunk ? bw.planChunks(w.earliest, w.latest) : [];
            const units = chunks.length > 1 ? chunks : [{ earliest: w.earliest, latest: w.latest, label: w.label }];
            const named = units.length > 1 || arm.wins.length > 1;
            units.forEach((u: any) => {
                items.push({
                    spl: arm.spl, armIndex: i + 1, armCount: arms.length, earliest: u.earliest, latest: u.latest,
                    chunkLabel: named ? u.label : '',
                });
            });
        });
    });
    return items;
};
const strip = (it: any): any => ({
    spl: it.spl, armIndex: it.armIndex, armCount: it.armCount, earliest: it.earliest, latest: it.latest, chunkLabel: it.chunkLabel,
});

{
    const runs: Array<[string, any[]]> = [
        ['30 days', [W30]],
        ['365 days', [W365]],
        ['a custom range', [win({ kind: 'custom', from: '2026-01-01', to: '2026-01-02' })]],
        ['the late-arrival windows', [win({ kind: 'custom', from: '2026-08-30', to: '2026-08-31' }),
            win({ kind: 'custom', from: '2026-09-15', to: '2026-09-15' }),
            win({ kind: 'custom', from: '2026-10-01', to: '2026-10-09' })]],
    ];
    let compared = 0;
    reg.ROLLUPS.forEach((def: any) => {
        const loaded = def.backfillStanzas.map((s: string) => ({ stanza: s, spl: searchOf(s) }));
        const hasStaged = loaded.some((l: any) => l.spl
            && bp.classifyTail(bp.parseUnion(l.spl).tail).kind === 'staged' && bp.parseUnion(l.spl).arms.length > 0);
        runs.forEach(([label, wins]) => {
            let k = 0;
            const now = bp.planRollupItems(loaded, wins, FIXED30, (s: string) => reg.FIXED30_BACKFILL_STANZAS.has(s),
                () => `rplan.${++k}`);
            const old = oldPlan(loaded, wins, FIXED30);
            if (!hasStaged) {
                compared += 1;
                eq(`E1 [${def.key}] ${label}: planned exactly as before`, now.map(strip), old);
                check(`E1 [${def.key}] ${label}: plain items only`, now.every((x: any) => x.kind === 'dispatch'),
                    JSON.stringify(now.map((x: any) => x.kind)));
                return;
            }
            // A rollup with a staged stanza: its row-local items are the old ones, in the old order.
            const stagedIdx = new Set<number>();
            now.forEach((x: any) => {
                if (x.kind === 'stage') stagedIdx.add(x.armIndex);
            });
            eq(`E2 [${def.key}] ${label}: the row-local items are the old ones, in order`,
                now.filter((x: any) => x.kind === 'dispatch').map(strip),
                old.filter((x: any) => !stagedIdx.has(x.armIndex)));
            eq(`E2 [${def.key}] ${label}: the arm numbering is the old one`,
                Array.from(new Set(now.map((x: any) => x.armCount))), Array.from(new Set(old.map((x: any) => x.armCount))));
            // Every staged part: all its arms, then its merge, over one window unit.
            const parts: string[] = [];
            now.forEach((x: any) => {
                if (x.part && parts.indexOf(x.part) === -1) parts.push(x.part);
            });
            parts.forEach((p) => {
                const its = now.map((x: any, i: number) => ({ x, i })).filter((o: any) => o.x.part === p);
                const merge = its.filter((o: any) => o.x.kind === 'merge');
                const stages = its.filter((o: any) => o.x.kind === 'stage');
                const stanzaArms = Array.from(new Set(stages.map((o: any) => o.x.armIndex)));
                check(`E3 [${def.key}] ${label} part ${p}: its arms, then one merge after all of them`,
                    merge.length === 1 && stages.length > 1 && stages.every((o: any) => o.i < merge[0].i)
                    && stanzaArms.length === stages.length,
                    JSON.stringify(its.map((o: any) => [o.x.kind, o.x.armIndex, o.i])));
                check(`E3 [${def.key}] ${label} part ${p}: one window unit`,
                    its.every((o: any) => o.x.earliest === its[0].x.earliest && o.x.latest === its[0].x.latest), '');
                check(`E3 [${def.key}] ${label} part ${p}: the stage and the merge name the part`,
                    stages.every((o: any) => o.x.spl.indexOf(`lsv_part="${p}"`) !== -1)
                    && merge.length === 1 && merge[0].x.spl.indexOf(`where lsv_part="${p}"`) !== -1, '');
            });
            // The staged arms' window units are exactly the old units of those arms.
            const oldUnits = old.filter((x: any) => stagedIdx.has(x.armIndex))
                .map((x: any) => `${x.armIndex}:${x.earliest}:${x.latest}:${x.chunkLabel}`).sort();
            const newUnits = now.filter((x: any) => x.kind === 'stage')
                .map((x: any) => `${x.armIndex}:${x.earliest}:${x.latest}:${x.chunkLabel}`).sort();
            eq(`E4 [${def.key}] ${label}: each staged arm covers the old window units, once`, newUnits, oldUnits);
            check(`E4 [${def.key}] ${label}: part ids are unique and well formed`,
                parts.every((p) => bp.isPartId(p)) && new Set(parts).size === parts.length, JSON.stringify(parts));
        });
    });
    check('E5 every rollup without a staged stanza was compared', compared === (reg.ROLLUPS.length - 1) * runs.length,
        `${compared} comparisons`);
    // A stanza that cannot be read, or every stanza: as before.
    const one = bp.planRollupItems([{ stanza: 'x', spl: null }, { stanza: 'y', spl: null }], [W30], FIXED30,
        () => false, () => 'r1.1');
    eq('E6 nothing readable: the failed sentinel, as before', one.map(strip),
        oldPlan([{ stanza: 'x', spl: null }, { stanza: 'y', spl: null }], [W30], FIXED30));
    check('E6 ... marked failed', one.length === 1 && one[0].kind === 'failed' && one[0].error.length > 0, '');
    const bad = bp.planRollupItems([{ stanza: 'z', spl: '| union [search a] [search b] | dedup x | outputlookup append=true c' }],
        [W30], FIXED30, () => false, () => 'r1.1');
    check('E7 a tail that cannot be staged dispatches nothing and says why',
        bad.length === 1 && bad[0].kind === 'failed' && bad[0].spl === '' && /dedup/.test(bad[0].error), JSON.stringify(bad));
    // An arm that names _key is staged like any other: every staged write drops _key (fields keeps underscore
    // fields), so each staged row gets a fresh key - proven in the row engine, D11.
    const keyed = bp.planRollupItems([{ stanza: 'k',
        spl: '| union [search a | eval _key=x] [search b] | stats sum(n) as n by k | outputlookup append=true c' }],
    [W30], FIXED30, () => false, () => 'r1.1');
    const keyedStages = keyed.filter((x: any) => x.kind === 'stage');
    check('E8 a staged stanza whose arm names _key is staged, and each staged write drops _key',
        keyedStages.length === 2 && keyed.filter((x: any) => x.kind === 'merge').length === 1
        && keyedStages.every((x: any) => / \| fields - _key \| outputlookup append=true override_if_empty=false logserv_backfill_stage$/
            .test(x.spl)),
        JSON.stringify(keyed.map((x: any) => [x.kind, x.spl])));
    const keyedPlain = bp.planRollupItems([{ stanza: 'k',
        spl: '| union [search a | eval _key=x] [search b] | eval m=1 | outputlookup append=true c' }],
    [W30], FIXED30, () => false, () => 'r1.1');
    check('E8 ... a row-local tail with such an arm is dispatched per arm, as before',
        keyedPlain.length >= 2 && keyedPlain.every((x: any) => x.kind === 'dispatch')
        && keyedPlain.some((x: any) => x.spl === 'search a | eval _key=x | eval m=1 | outputlookup append=true c'),
        JSON.stringify(keyedPlain.map((x: any) => [x.kind, x.spl])));
}

/* ======================= F. the execution rules ======================= */

{
    check('F1 a part is combined when every arm is done', bp.mergeAllowed(['done', 'done', 'done'], 3), '');
    check('F1 ... not when one failed', !bp.mergeAllowed(['done', 'failed', 'done'], 3), '');
    check('F1 ... not when one was truncated', !bp.mergeAllowed(['done', 'truncated'], 2), '');
    check('F1 ... not when one is still running on the server', !bp.mergeAllowed(['detached', 'done'], 2), '');
    check('F1 ... not before every arm has reported', !bp.mergeAllowed(['done', 'done'], 3), '');
    check('F1 ... not for an empty part', !bp.mergeAllowed([], 0), '');
    check('F2 a settled part\'s stage rows go', bp.stageDeletable('done') && bp.stageDeletable('failed')
        && bp.stageDeletable('truncated') && bp.stageDeletable('skipped'), '');
    check('F2 ... but not while a combine search the panel stopped waiting for may still read them',
        !bp.stageDeletable('detached'), '');
    check('F2 ... nor when the part did not reconcile (the rows are the evidence)', !bp.stageDeletable('unreconciled'), '');
    eq('F12 the row verdict of a combine step', ['done', 'failed', 'truncated', 'detached', 'skipped', 'unreconciled']
        .map((m) => bp.mergeRowVerdict(m)), ['done', 'failed', 'truncated', 'detached', 'failed', 'failed']);
    eq('F3 a staged arm left running is a failure to re-run (it is never combined)', bp.stagedArmRowVerdict('detached'), 'failed');
    eq('F3 ... other verdicts pass through', ['done', 'failed', 'truncated'].map((v) => bp.stagedArmRowVerdict(v)),
        ['done', 'failed', 'truncated']);
    eq('F4 the part query', bp.partQuery('rabc.3'), { lsv_part: 'rabc.3' });
    const oq = bp.orphanQuery(1790000000.7);
    eq('F5 the orphan query bounds lsv_staged_at by a JSON number, 7 days back', JSON.stringify(oq),
        `{"lsv_staged_at":{"$lt":${1790000000 - 7 * 86400}}}`);
    check('F5 ... and the age is longer than one part can live', bp.STAGE_ORPHAN_AGE_SECONDS >= 2 * 86400, '');
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) ids.add(bp.newRunId(NOW_MS + i, (i * 0.618033) % 1));
    check('F6 run ids are distinct and make well-formed part ids', ids.size === 200
        && Array.from(ids).every((r) => bp.isPartId(`${r}.1`) && bp.isPartId(`${r}.42`)), Array.from(ids).slice(0, 2).join(','));
    check('F6 a part id cannot carry a quote or a pipe', !bp.isPartId('r1.1" | delete') && !bp.isPartId('r1') && !bp.isPartId('R1.1'), '');
    let threw = false;
    try {
        bp.stageWriteSpl('search x', { kind: 'staged', prefix: [], stats: 'stats count by a', rest: [], inputs: ['a'] }, 'r1.1"x');
    } catch (e) {
        threw = e instanceof Error;
    }
    check('F7 a bad part id is never written into SPL', threw, '');
    eq('F8 the stage fields', Array.from(bp.STAGE_FIELDS_LIST),
        ['_key', 'lsv_part', 'lsv_staged_at', 'lsv_f1', 'lsv_f2', 'lsv_f3', 'lsv_f4', 'lsv_f5', 'lsv_f6', 'lsv_f7', 'lsv_f8']);
    const form = bp.classifyTail('| stats sum(n) as n by k, _time | rename _time as b | outputlookup append=true c');
    eq('F9 the staged arm search', bp.stageWriteSpl('search s | bin _time span=1h | stats count as n by k, _time', form, 'rx.1'),
        'search s | bin _time span=1h | stats count as n by k, _time | eval lsv_part="rx.1", lsv_staged_at=now()'
        + ' | rename n as lsv_f1, k as lsv_f2, _time as lsv_f3 | fields lsv_part, lsv_staged_at, lsv_f1, lsv_f2, lsv_f3'
        + ' | fields - _key | outputlookup append=true override_if_empty=false logserv_backfill_stage');
    eq('F9 the combine search', bp.stageMergeSpl(form, 'rx.1'),
        '| inputlookup logserv_backfill_stage where lsv_part="rx.1" | rename lsv_f1 as n, lsv_f2 as k'
        + ' | eval _time=tonumber(lsv_f3) | fields - _key, lsv_part, lsv_staged_at, lsv_f3'
        + ' | stats sum(n) as n by k, _time | rename _time as b | outputlookup append=true c');
    const pre = bp.classifyTail('| eval k=lower(a) | where k!="x" | stats sum(n) as n by k | outputlookup append=true c');
    eq('F11 a row-local prefix runs in the staged arm, before the stage write (the stats reads its output)',
        bp.stageWriteSpl('search s', pre, 'rx.2'),
        'search s | eval k=lower(a) | where k!="x" | eval lsv_part="rx.2", lsv_staged_at=now()'
        + ' | rename n as lsv_f1, k as lsv_f2 | fields lsv_part, lsv_staged_at, lsv_f1, lsv_f2'
        + ' | fields - _key | outputlookup append=true override_if_empty=false logserv_backfill_stage');
    eq('F11 ... and not again in the combine search', bp.stageMergeSpl(pre, 'rx.2'),
        '| inputlookup logserv_backfill_stage where lsv_part="rx.2" | rename lsv_f1 as n, lsv_f2 as k'
        + ' | fields - _key, lsv_part, lsv_staged_at | stats sum(n) as n by k | outputlookup append=true c');
    const sub = (spl: string): string[] => bp.splitCommands(spl)
        .filter((c: string) => /\[/.test(c.replace(/"(?:[^"\\]|\\.)*"/g, '""'))
            || ['append', 'appendcols', 'join', 'union', 'map'].indexOf(bp.commandName(c)) !== -1);
    eq('F10 neither the stage, the count nor the combine search opens a subsearch',
        sub(bp.stageMergeSpl(form, 'rx.1')).concat(sub(bp.stageWriteSpl('search s', form, 'rx.1')))
            .concat(sub(bp.guardedMergeSpl(bp.stageMergeSpl(form, 'rx.1'), 'rx.1', 5))).concat(sub(bp.stageCountSpl('rx.1'))), []);
}

/* ======================= G. the registry and the stage ======================= */

{
    const keys = reg.ROLLUPS.map((d: any) => d.key);
    const clear: string[] = Array.from(reg.UPGRADE_NOTE_CLEAR_THEN_BACKFILL || []);
    const only: string[] = Array.from(reg.UPGRADE_NOTE_BACKFILL_ONLY || []);
    eq('G1 the rows the upgrade note asks to Clear then Backfill (design_impact.md section 4)', clear.slice().sort(),
        ['abapnet', 'hana', 'hana_trace', 'hostdetails', 'hostrole', 'mc', 'pipeline', 'severity', 'stmap',
            'topology_detail', 'topology_graph']);
    eq('G2 the rows it asks to Backfill without Clear (h1 decision 3)', only.slice().sort(), ['compliance', 'xstack_auth']);
    check('G3 every one is a registered rollup', clear.concat(only).every((k) => keys.indexOf(k) !== -1),
        clear.concat(only).filter((k) => keys.indexOf(k) === -1).join(', '));
    check('G3 ... and no row is in both lists', clear.every((k) => only.indexOf(k) === -1), '');
    // Build 381: the trace-component names - Work Process Performance keys metric "wp" on them.
    const names: string[] = Array.from(reg.UPGRADE_NOTE_TRACE_NAMES || []);
    eq('G6 the row the trace-name note asks to Clear then Backfill', names, ['wp_perf']);
    check('G6 ... is a registered rollup that writes the wp metric',
        names.every((k) => keys.indexOf(k) !== -1)
        && /eval metric="wp"/.test(SS.logserv_wp_perf_aggregate || '')
        && /fillnull value="\(none\)" sap_sid sap_instance wp_function wp_category_name \| stats count by sap_sid, sap_instance, wp_function, wp_category_name,/
            .test(SS.logserv_wp_perf_aggregate || ''),
        'the wp arm must still key on wp_category_name, the field the note is about');
    check('G4 the stage is in no rollup (Clear, history and the Data Doctor never see it)',
        reg.ALL_COLLECTIONS.indexOf(bp.STAGE_COLLECTION) === -1, '');
    const users = Object.keys(SS).filter((n) => (SS[n] || '').split('\n')
        .some((l) => !/^\s*#/.test(l) && l.indexOf(bp.STAGE_COLLECTION) !== -1));
    eq('G5 no saved search reads, writes or trims the stage (no retention can meet a half-written part)', users, []);
}

/* ======================= H. every staged row is accounted for ======================= */

{
    const job = (content: any): any => ({ entry: [{ content }] });
    eq('H1 a finished job proves its result count', bp.readJobFacts(200, job({ isDone: true, resultCount: 42, messages: [] })),
        { ok: true, resultCount: 42 });
    eq('H1 ... sent as strings', bp.readJobFacts(200, job({ isDone: '1', resultCount: '7' })), { ok: true, resultCount: 7 });
    eq('H1 ... zero rows is a count', bp.readJobFacts(200, job({ isDone: true, resultCount: 0 })), { ok: true, resultCount: 0 });
    eq('H1 ... a WARN or INFO message does not matter', bp.readJobFacts(200, job({ isDone: true, resultCount: 3,
        messages: [{ type: 'WARN', text: 'w' }, { type: 'INFO', text: 'i' }] })), { ok: true, resultCount: 3 });
    ([
        ['an ERROR message', 200, job({ isDone: true, resultCount: 5, messages: [{ type: 'ERROR', text: "Error in 'outputlookup' command" }] })],
        ['a FATAL message, any case', 200, job({ isDone: true, resultCount: 5, messages: [{ type: 'fatal', text: '' }] })],
        ['an unfinished job', 200, job({ isDone: false, resultCount: 5 })],
        ['no result count', 200, job({ isDone: true })],
        ['a negative count', 200, job({ isDone: true, resultCount: -1 })],
        ['a fractional count', 200, job({ isDone: true, resultCount: 2.5 })],
        ['a count that is not a number', 200, job({ isDone: true, resultCount: '12abc' })],
        ['no entry', 200, {}],
        ['no body', 200, null],
        ['HTTP 404', 404, job({ isDone: true, resultCount: 1 })],
    ] as Array<[string, number, any]>).forEach(([what, status, body]) => check(`H1 proves nothing: ${what}`,
        bp.readJobFacts(status, body).ok === false && String(bp.readJobFacts(status, body).reason).length > 0,
        JSON.stringify(bp.readJobFacts(status, body))));

    eq('H2 a done staged arm with facts stages its rows', bp.stagedArmResult('done', { ok: true, resultCount: 9 }),
        { verdict: 'done', rows: 9, reason: '' });
    eq('H2 a done staged arm whose job proves nothing fails, with the reason',
        bp.stagedArmResult('done', { ok: false, reason: 'why' }), { verdict: 'failed', rows: 0, reason: 'why' });
    eq('H2 other verdicts pass through and stage nothing', ['failed', 'truncated', 'detached']
        .map((v) => bp.stagedArmResult(v, { ok: true, resultCount: 9 })),
    [{ verdict: 'failed', rows: 0, reason: '' }, { verdict: 'truncated', rows: 0, reason: '' }, { verdict: 'detached', rows: 0, reason: '' }]);
    eq('H2 a combine search that ended with an ERROR fails', [
        bp.mergeJobVerdict('done', { ok: true, resultCount: 1 }), bp.mergeJobVerdict('done', { ok: false, reason: 'x' }),
        bp.mergeJobVerdict('detached', { ok: false, reason: 'x' }), bp.mergeJobVerdict('failed', { ok: true, resultCount: 1 })],
    ['done', 'failed', 'detached', 'failed']);

    eq('H3 the count search', bp.stageCountSpl('rx.4'), '| inputlookup logserv_backfill_stage where lsv_part="rx.4" | stats count as n');
    let threwH3 = false;
    try {
        bp.stageCountSpl('r1.1" | delete');
    } catch (e) {
        threwH3 = e instanceof Error;
    }
    check('H3 a bad part id is never written into the count search', threwH3, '');
    eq('H3 a count row', bp.classifyPartCount(200, { results: [{ n: '12' }] }), { kind: 'ok', n: 12 });
    eq('H3 ... a zero count', bp.classifyPartCount(200, { results: [{ n: 0 }] }), { kind: 'ok', n: 0 });
    check('H3 no row is a failed read, not zero', bp.classifyPartCount(200, { results: [] }).kind === 'failed', '');
    check('H3 a row without a number is a failed read, not zero', bp.classifyPartCount(200, { results: [{ m: 1 }] }).kind === 'failed'
        && bp.classifyPartCount(200, { results: [{ n: 'x' }] }).kind === 'failed', '');
    eq('H3 a busy search head', bp.classifyPartCount(503, null).kind, 'busy');
    eq('H3 an ERROR message', bp.classifyPartCount(200, { messages: [{ type: 'ERROR', text: 'boom' }], results: [{ n: 3 }] }).kind,
        'failed');

    eq('H4 the count matches', bp.decidePartCount({ kind: 'ok', n: 7 }, 7, 1), { kind: 'match' });
    eq('H4 nothing staged and nothing read', bp.decidePartCount({ kind: 'ok', n: 0 }, 0, 1), { kind: 'match' });
    eq('H4 short, empty, over or unreadable: retried 5 s, 15 s, 30 s', [1, 2, 3].map((a) => bp.decidePartCount({ kind: 'ok', n: 6 }, 7, a)),
        [{ kind: 'retry', delayMs: 5000 }, { kind: 'retry', delayMs: 15000 }, { kind: 'retry', delayMs: 30000 }]);
    eq('H4 ... the same for an over-read and a busy head', [bp.decidePartCount({ kind: 'ok', n: 8 }, 7, 1),
        bp.decidePartCount({ kind: 'busy', reason: 'b' }, 7, 2), bp.decidePartCount({ kind: 'failed', reason: 'f' }, 7, 1)],
    [{ kind: 'retry', delayMs: 5000 }, { kind: 'retry', delayMs: 15000 }, { kind: 'retry', delayMs: 5000 }]);
    const lastShort = bp.decidePartCount({ kind: 'ok', n: 0 }, 7, 4);
    check('H4 then a mismatch that names both counts', lastShort.kind === 'mismatch' && /7/.test(lastShort.reason)
        && /\b0 read back/.test(lastShort.reason), JSON.stringify(lastShort));
    const lastBusy = bp.decidePartCount({ kind: 'busy', reason: 'search head busy' }, 7, 4);
    check('H4 ... or the reason it could not count', lastBusy.kind === 'mismatch' && /search head busy/.test(lastBusy.reason),
        JSON.stringify(lastBusy));
    check('H4 no usable expected count is a mismatch', ['x', -1, 1.5, NaN].every((x) => bp.decidePartCount({ kind: 'ok', n: 1 }, x, 1).kind
        === 'mismatch'), '');

    const mspl = '| inputlookup logserv_backfill_stage where lsv_part="rx.9" | rename lsv_f1 as n | fields - _key, lsv_part, lsv_staged_at'
        + ' | stats sum(n) as n by k | outputlookup append=true c';
    eq('H5 with rows staged, the combine fails on an empty read: require right after the read', bp.guardedMergeSpl(mspl, 'rx.9', 3),
        '| inputlookup logserv_backfill_stage where lsv_part="rx.9" | require | rename lsv_f1 as n | fields - _key, lsv_part, lsv_staged_at'
        + ' | stats sum(n) as n by k | outputlookup append=true c');
    eq('H5 with nothing staged, as planned (a stats without by still writes its one row, as the union would)',
        bp.guardedMergeSpl(mspl, 'rx.9', 0), mspl);
    const threwH5 = [(): string => bp.guardedMergeSpl(mspl, 'rx.8', 3), (): string => bp.guardedMergeSpl(mspl, 'rx.9', -1),
        (): string => bp.guardedMergeSpl(mspl, 'rx.9', 1.5), (): string => bp.guardedMergeSpl('search x', 'rx.9', 1)].map((f) => {
        try {
            f();
            return false;
        } catch (e) {
            return e instanceof Error;
        }
    });
    eq('H5 another part\'s search, a bad count or a search that is not a combine is refused', threwH5, [true, true, true, true]);

    eq('H6 the server clock from a Date header', bp.serverClockSec('Sat, 10 Oct 2026 04:00:00 GMT'), Math.floor(Date.UTC(2026, 9, 10, 4) / 1000));
    eq('H6 ... none usable: no sweep', [null, undefined, '', 'garbage', 'Thu, 01 Jan 1970 00:00:00 GMT'].map((d) => bp.serverClockSec(d)),
        [null, null, null, null, null]);

    /* H7 - the panel's sequence, run in the row engine on the shipped nodes backfill: each staged arm through
     * its job facts, the counts before and after (with their retries, not slept), the guarded combine. */
    interface Faults {
        afterArms?: (kv: Kv, part: string) => void;
        beforeCount?: (kv: Kv, part: string, attempt: number, phase: string) => void;
        busy?: (attempt: number, phase: string) => boolean;
        beforeMerge?: (kv: Kv, part: string) => void;
        afterMerge?: (kv: Kv, part: string) => void;
        armBody?: (armIndex: number, rows: number) => unknown;
        /** the combine search's job ends DONE with this ERROR message (its write failed). */
        mergeError?: string;
    }
    interface SimPart { outcome: string; verdict: string; kept: boolean; expected: number; delays: number[]; staged: number }
    const partRows = (kv: Kv, part: string): Row[] => {
        const m = kv.data[bp.STAGE_COLLECTION];
        return Array.from(m.values()).filter((r) => r[bp.STAGE_PART_FIELD] === part);
    };
    const simulate = (spl: string, rowsByArm: Row[][], faults: Faults): { kv: Kv; parts: SimPart[] } => {
        const kv = newKv();
        const { arms } = bp.parseUnion(spl);
        let n = 0;
        const items = bp.planRollupItems([{ stanza: NODES, spl }], [W30], FIXED30, () => false, () => `rsim.${++n}`);
        const out: SimPart[] = [];
        const partIds: string[] = [];
        items.forEach((x: any) => {
            if (x.part && partIds.indexOf(x.part) === -1) partIds.push(x.part);
        });
        partIds.forEach((part) => {
            const its = items.filter((x: any) => x.part === part);
            let expected = 0;
            const verdicts: string[] = [];
            its.filter((x: any) => x.kind === 'stage').forEach((it: any) => {
                const arm = arms[it.armIndex - 1];
                const passed = runPipeline(bp.splitCommands(it.spl.slice(arm.length + 3)),
                    rowsByArm[it.armIndex - 1].filter((r) => inWindow(r, it.earliest, it.latest)), kv);
                const body = faults.armBody ? faults.armBody(it.armIndex, passed.length)
                    : job({ isDone: true, resultCount: passed.length, messages: [] });
                const r = bp.stagedArmResult('done', bp.readJobFacts(200, body));
                expected += r.rows;
                verdicts.push(r.verdict);
            });
            if (faults.afterArms) faults.afterArms(kv, part);
            const delays: number[] = [];
            const count = (phase: string): any => {
                for (let attempt = 1; attempt < 20; attempt += 1) {
                    if (faults.beforeCount) faults.beforeCount(kv, part, attempt, phase);
                    const a = faults.busy && faults.busy(attempt, phase)
                        ? bp.classifyPartCount(503, null)
                        : bp.classifyPartCount(200, { results: runPipeline(bp.splitCommands(bp.stageCountSpl(part)), null, kv) });
                    const d = bp.decidePartCount(a, expected, attempt);
                    if (d.kind !== 'retry') return d;
                    delays.push(d.delayMs);
                }
                throw new Error('decidePartCount never settled');
            };
            let outcome = 'skipped';
            if (bp.mergeAllowed(verdicts, verdicts.length)) {
                if (count('before').kind === 'mismatch') outcome = 'unreconciled';
                else {
                    const merge = its.find((x: any) => x.kind === 'merge');
                    if (faults.beforeMerge) faults.beforeMerge(kv, part);
                    let v = 'done';
                    let facts: any;
                    try {
                        const wrote = runPipeline(bp.splitCommands(bp.guardedMergeSpl(merge.spl, part, expected)), null, kv);
                        facts = bp.readJobFacts(200, job({ isDone: true, resultCount: wrote.length,
                            messages: faults.mergeError ? [{ type: 'ERROR', text: faults.mergeError }] : [] }));
                    } catch (e) {
                        if (!(e instanceof RequireFailed)) throw e;
                        v = 'failed'; // a search that `require` stops ends FAILED
                        facts = bp.readJobFacts(200, job({ isDone: true, isFailed: true, messages: [{ type: 'ERROR', text: e.message }] }));
                    }
                    if (faults.afterMerge) faults.afterMerge(kv, part);
                    outcome = bp.mergeJobVerdict(v, facts);
                    if (outcome === 'done' && count('after').kind === 'mismatch') outcome = 'unreconciled';
                }
            }
            kv.blind.clear();
            const kept = !bp.stageDeletable(outcome);
            if (!kept) kv.remove(bp.STAGE_COLLECTION, (r) => r[bp.STAGE_PART_FIELD] === part);
            out.push({ outcome, verdict: bp.mergeRowVerdict(outcome), kept, expected, delays, staged: partRows(kv, part).length });
        });
        return { kv, parts: out };
    };
    if (nodesSpl) {
        try {
            const nArms = bp.parseUnion(nodesSpl).arms as string[];
            ENGINE_NOW = Math.floor(NOW_MS / 1000);
            const hrs = [H('2026-09-20T10:00:00Z'), H('2026-10-09T21:00:00Z')];
            const rows = nArms.map((a, i) => nodeRows(a, i + 1, hrs));
            const kvU = newKv();
            runUnion(nodesSpl, rows, [W30], kvU);
            const U = finalRows(kvU, 'logserv_topology_nodes');
            const nodesOf = (kv: Kv): Record<string, Row> => finalRows(kv, 'logserv_topology_nodes');
            const one = (r: { kv: Kv; parts: SimPart[] }): SimPart => r.parts[0];

            const clean = simulate(nodesSpl, rows, {});
            check('H7 clean: one part, done, the rows equal the union, the stage emptied',
                clean.parts.length === 1 && one(clean).outcome === 'done' && one(clean).expected > 10
                && Object.keys(U).length > 10 && diffKeys(U, nodesOf(clean.kv)).length === 0
                && one(clean).staged === 0 && one(clean).delays.length === 0, JSON.stringify(one(clean)));

            const short = simulate(nodesSpl, rows, { afterArms: (kv, part) => {
                const k = partRows(kv, part)[0]._key as string;
                kv.data[bp.STAGE_COLLECTION].delete(k);
            } });
            check('H7 a short read (one staged row lost): not combined, failed, nothing written, the rows kept',
                one(short).outcome === 'unreconciled' && one(short).verdict === 'failed' && Object.keys(nodesOf(short.kv)).length === 0
                && one(short).kept && one(short).staged === one(short).expected - 1
                && JSON.stringify(one(short).delays) === '[5000,15000,30000]', JSON.stringify(one(short)));

            const empty = simulate(nodesSpl, rows, { beforeCount: (kv) => kv.blind.add(bp.STAGE_COLLECTION) });
            check('H7 an empty read (KV Store still warming): not combined, failed, nothing written, the rows kept',
                one(empty).outcome === 'unreconciled' && one(empty).verdict === 'failed' && Object.keys(nodesOf(empty.kv)).length === 0
                && one(empty).kept && one(empty).staged === one(empty).expected, JSON.stringify(one(empty)));

            const over = simulate(nodesSpl, rows, { afterArms: (kv, part) => kv.write(bp.STAGE_COLLECTION, [{ lsv_part: part,
                lsv_staged_at: 1, lsv_f1: '5', lsv_f2: '1', lsv_f3: 'ip', lsv_f4: '10.186.72.120', lsv_f5: String(hrs[0]) }], true) });
            check('H7 an over-read (a stray row in the part): not combined, failed, nothing written',
                one(over).outcome === 'unreconciled' && one(over).verdict === 'failed' && Object.keys(nodesOf(over.kv)).length === 0,
                JSON.stringify(one(over)));

            const warm = simulate(nodesSpl, rows, { beforeCount: (kv, part, attempt, phase) => {
                if (phase === 'before' && attempt <= 2) kv.blind.add(bp.STAGE_COLLECTION);
                else kv.blind.delete(bp.STAGE_COLLECTION);
            } });
            check('H7 a read that recovers (empty twice, then whole): combined after 5 s + 15 s, the rows equal the union',
                one(warm).outcome === 'done' && diffKeys(U, nodesOf(warm.kv)).length === 0
                && JSON.stringify(one(warm).delays) === '[5000,15000]', JSON.stringify(one(warm)));

            const busy = simulate(nodesSpl, rows, { busy: (attempt, phase) => phase === 'before' && attempt === 1 });
            check('H7 a busy search head at the first count: retried, then combined',
                one(busy).outcome === 'done' && diffKeys(U, nodesOf(busy.kv)).length === 0 && JSON.stringify(one(busy).delays) === '[5000]',
                JSON.stringify(one(busy)));

            const race = simulate(nodesSpl, rows, {
                beforeMerge: (kv) => kv.blind.add(bp.STAGE_COLLECTION),
                afterMerge: (kv) => kv.blind.delete(bp.STAGE_COLLECTION),
            });
            check('H7 the count matched but the combine read nothing: require fails it - failed, nothing written',
                one(race).outcome === 'failed' && one(race).verdict === 'failed' && Object.keys(nodesOf(race.kv)).length === 0,
                JSON.stringify(one(race)));

            const raceShort = simulate(nodesSpl, rows, { beforeMerge: (kv, part) => {
                const k = partRows(kv, part)[0]._key as string;
                kv.data[bp.STAGE_COLLECTION].delete(k);
            } });
            check('H7 a row lost between the count and the combine: the count after it fails the part (re-run)',
                one(raceShort).outcome === 'unreconciled' && one(raceShort).verdict === 'failed' && one(raceShort).kept,
                JSON.stringify(one(raceShort)));

            const errArm = simulate(nodesSpl, rows, { armBody: (armIndex, nRows) => job({ isDone: true, resultCount: nRows,
                messages: armIndex === 2 ? [{ type: 'ERROR', text: "Error in 'outputlookup' command: KV Store write failed" }] : [] }) });
            check('H7 a staged arm that ended with an ERROR message: not combined, failed, nothing written',
                one(errArm).outcome === 'skipped' && one(errArm).verdict === 'failed' && Object.keys(nodesOf(errArm.kv)).length === 0
                && !one(errArm).kept, JSON.stringify(one(errArm)));

            const mergeErr = simulate(nodesSpl, rows, { mergeError: "Error in 'outputlookup' command: KV Store write failed" });
            check('H7 a combine search whose write ended with an ERROR message: failed (re-run), not done',
                one(mergeErr).outcome === 'failed' && one(mergeErr).verdict === 'failed', JSON.stringify(one(mergeErr)));

            const underCount = simulate(nodesSpl, rows, { armBody: (armIndex, nRows) => job({ isDone: true,
                resultCount: armIndex === 1 ? nRows - 1 : nRows, messages: [] }) });
            check('H7 a job that reports fewer rows than the stage holds: the counts disagree - failed, nothing written',
                one(underCount).outcome === 'unreconciled' && Object.keys(nodesOf(underCount.kv)).length === 0, JSON.stringify(one(underCount)));

            /* The control: the unguarded combine over an empty read finishes and writes nothing - the silent hole
             * the counts and `require` close. */
            const kvC = newKv();
            const items = bp.planRollupItems([{ stanza: NODES, spl: nodesSpl }], [W30], FIXED30, () => false, () => 'rctl.1');
            items.filter((x: any) => x.kind === 'stage').forEach((it: any) => runPipeline(
                bp.splitCommands(it.spl.slice(nArms[it.armIndex - 1].length + 3)),
                rows[it.armIndex - 1].filter((r) => inWindow(r, it.earliest, it.latest)), kvC));
            kvC.blind.add(bp.STAGE_COLLECTION);
            const unguarded = runPipeline(bp.splitCommands(items.find((x: any) => x.kind === 'merge').spl), null, kvC);
            check('H7 control: without them an empty read ends cleanly having written nothing',
                unguarded.length === 0 && Object.keys(nodesOf(kvC)).length === 0, '');
        } catch (e) {
            check('H7 the simulation ran', false, String(e && (e as any).stack ? (e as any).stack : e));
        }
    }
}

/* ===================================================================== */

if (bpFailures > 0) {
    process.stderr.write(`\nbackfillPlan.consistency-test: ${bpFailures} failure(s) of ${bpChecks}\n`);
    process.exit(1);
}
console.log(`backfillPlan.consistency-test: OK (${bpChecks} checks)`);
