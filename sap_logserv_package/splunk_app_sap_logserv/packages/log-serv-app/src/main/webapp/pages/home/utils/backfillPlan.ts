/**
 * backfillPlan - what the Settings -> Dashboard Data backfill dispatches, and
 * how a union whose tail combines rows ACROSS its arms stays exact (build 378,
 * design_impact.md finding F1).
 *
 * WHY PER-ARM DISPATCH EXISTS. Each [logserv_*_backfill] saved search is
 * `| union [arm1] .. [armN] <tail>`. Splunk runs a union's non-first arms as
 * subsearches that it auto-finalizes after about 30 seconds, and a truncated arm
 * silently writes LOWER counts over good rows (sessions 054 and 147). The panel
 * therefore dispatches every `<arm> <tail>` as its own TOP-LEVEL search, which
 * has no such limit. For a tail that acts on one row at a time (eval, fields,
 * outputlookup append=true - every rollup but two) that is exactly the union.
 *
 * WHY THAT IS WRONG FOR TWO TAILS. The Environment Topology nodes tail starts
 * `stats sum(event_count) ... by canonical_kind, canonical_value, _time`: an IP
 * that two arms both report (a gateway L= address that is also an ICM local
 * address) is ONE row whose count is the sum. Dispatched per arm, each arm wrote
 * its own partial count to the same _key and the last arm to finish won - an
 * undercount. The inventory tail starts `stats sum(n), max(last_seen) ... by
 * canonical_value, canonical_kind, resolved_sid` and then chooses one SID per
 * endpoint over every arm's rows (build 379: the SIDs of its most recent hour,
 * then the most events; an exact tie writes nothing); per arm, each arm chose
 * on its own rows and the last arm to finish won - a SID the union over the
 * same window would not choose.
 *
 * THE FIX - STAGE, THEN COMBINE. A tail whose first row-combining command is a
 * `stats` over order-free functions is split there. Each arm is still its own
 * top-level search (no subsearch, no auto-finalize), but it writes the fields
 * that stats reads - nothing else - into the scratch KV collection
 * STAGE_COLLECTION under one part id. When every arm of the part has finished
 * cleanly, ONE top-level combine search reads exactly that part back
 * (`| inputlookup ... where lsv_part=...`, never a subsearch) and runs the
 * stanza's own stats and the rest of its own tail, unchanged. stats over the
 * concatenated arm rows IS the union's stats, so the rows written equal a
 * single-pipeline union over the same window; the consistency test proves it on
 * the shipped stanzas with overlapping keys and a cross-arm SID conflict.
 *
 * A part is one chunk of one window: the nodes rows are hourly, so a monthly
 * chunk owns its hours outright, and the inventory is pinned to one 30-day
 * window (FIXED30_BACKFILL_STANZAS), so it is one part. A part is combined only
 * when ALL of its arms report done; otherwise nothing is written for it and the
 * row is marked failed (re-run). Nothing scheduled reads or trims the stage - no
 * retention can ever see a half-written part - and its rows are deleted by the
 * panel once the part is settled (or, for a part left behind by a closed page,
 * after STAGE_ORPHAN_AGE_SECONDS, measured on the server's clock).
 *
 * EVERY STAGED ROW IS ACCOUNTED FOR. "All arms done" is not enough on its own:
 * a KV Store read can come back short or empty (mongod warming up after a
 * restart, a replica catching up), and a job can end DONE with an ERROR
 * message on its write. So a staged arm counts as done only when its job
 * entry carries no ERROR / FATAL message and a result count (a search ending
 * in outputlookup returns the rows it wrote - readJobFacts); the part's
 * expected size is the sum of those counts; before the combine search runs,
 * the stage must answer that the part holds exactly that many rows
 * (decidePartCount, retried for warm-up); the combine search itself fails on
 * an empty read (`require`, guardedMergeSpl) and must end without an ERROR
 * message; and afterwards the part is counted once more. Any difference fails
 * the part - nothing is reported done that did not read every row - and its
 * staged rows are kept for inspection until the orphan sweep.
 *
 * Every stanza whose tail is row-local is planned EXACTLY as before this module
 * existed (the consistency test compares item for item with the old algorithm).
 *
 * Pure: no fetch, no clock reads, no randomness - the panel supplies those.
 */

import { planChunks } from './backfillWindow';
import type { ResolvedWindow } from './backfillWindow';
import type { ArmVerdict } from './backfillPoll';
import { classifyCheckResponse } from './historyCheck';

/** The scratch KV collection staged arms write and combine searches read.
 *  Defined in collections.conf / transforms.conf; read or written by no saved
 *  search, listed in no rollup (not cleared, not history-checked, not readable
 *  by the AI Assistant). */
export const STAGE_COLLECTION = 'logserv_backfill_stage';
/** The part a staged row belongs to: `<run id>.<n>`. */
export const STAGE_PART_FIELD = 'lsv_part';
/** When the staging search started (epoch seconds, a KV number). */
export const STAGE_TIME_FIELD = 'lsv_staged_at';
/** Generic value slots: a staged arm renames the fields its tail's stats reads
 *  into lsv_f1..lsv_fN, the combine search renames them back. Generic so the
 *  stage's schema never has to follow a rollup's. */
export const STAGE_SLOTS = 8;
export const STAGE_SLOT_FIELDS: readonly string[] = Array.from({ length: STAGE_SLOTS }, (_, i) => `lsv_f${i + 1}`);
/** The transforms.conf fields_list the stage lookup must declare, in order
 *  (outputlookup writes only fields_list fields). */
export const STAGE_FIELDS_LIST: readonly string[] = ['_key', STAGE_PART_FIELD, STAGE_TIME_FIELD].concat(STAGE_SLOT_FIELDS);
/** Staged rows older than this belong to no part that can still be combined
 *  (a part lives for its own arms and one combine search - hours at most), so
 *  the next run deletes them. */
export const STAGE_ORPHAN_AGE_SECONDS = 7 * 86400;

const SIMPLE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PART_ID = /^r[a-z0-9]+\.[0-9]+$/;

/** Quote-aware union splitter - port of fix_backfill.py parse_union (moved here
 *  unchanged from RollupBackfillPanel.tsx). Tracks double-quote state (counting
 *  consecutive preceding backslashes so an escaped backslash `\\"` is NOT
 *  mistaken for an escaped quote `\"`) so `[`/`]` inside quoted rex regexes
 *  (e.g. linux's "kernel:.*?\]...") don't confuse arm boundaries. Returns
 *  arms=[] for a single-pipeline (no `| union`) search - the caller then
 *  dispatches the whole SPL as one top-level search. */
export const parseUnion = (spl: string): { arms: string[]; tail: string } => {
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

/** Split a pipeline into its commands at the pipes that are outside double
 *  quotes and outside [ ] subsearch brackets. Each command is trimmed and has no
 *  leading pipe; empty ones are dropped. */
export const splitCommands = (spl: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let inQ = false;
    let start = 0;
    for (let i = 0; i < spl.length; i += 1) {
        const ch = spl[i];
        if (ch === '"') {
            let bs = 0;
            let j = i - 1;
            while (j >= 0 && spl[j] === '\\') {
                bs += 1;
                j -= 1;
            }
            if (bs % 2 === 0) inQ = !inQ;
        } else if (!inQ) {
            if (ch === '[') depth += 1;
            else if (ch === ']') depth -= 1;
            else if (ch === '|' && depth === 0) {
                out.push(spl.slice(start, i).trim());
                start = i + 1;
            }
        }
    }
    out.push(spl.slice(start).trim());
    return out.filter((c) => c.length > 0);
};

/** The command word of one command, lower-cased ('' when there is none). */
export const commandName = (cmd: string): string => {
    const m = /^([A-Za-z_]+)/.exec(cmd.trim());
    return m ? m[1].toLowerCase() : '';
};

/** Commands that act on one row at a time: running them on each arm's rows and
 *  concatenating gives what running them on the union gives. Anything else in a
 *  tail is treated as combining rows across arms. outputlookup counts as
 *  row-local only with append=true: a full overwrite per arm would leave only the
 *  last arm's rows (classifyTail refuses it). */
export const ROW_LOCAL_COMMANDS: ReadonlySet<string> = new Set<string>([
    'eval', 'rename', 'fields', 'where', 'search', 'fillnull', 'rex', 'outputlookup', 'table', 'convert',
    'makemv', 'nomv', 'mvexpand', 'spath', 'lookup',
]);

/** fillnull acts on one row at a time only when it names its fields. Without a
 *  field list (or with a wildcard) it fills every field that ANY row of the
 *  results has, so over a union arm A's rows get arm B's fields - per arm they
 *  do not. */
export const fillnullNamesFields = (cmd: string): boolean => {
    const body = cmd.trim().replace(/^fillnull\b/i, '').replace(/\bvalue\s*=\s*("(?:[^"\\]|\\.)*"|\S+)/i, ' ');
    const names = body.split(/[\s,]+/).filter((t) => t.length > 0);
    return names.length > 0 && names.every((t) => SIMPLE_FIELD.test(t));
};

/** One command of a tail acts on one row at a time (see ROW_LOCAL_COMMANDS). */
export const isRowLocal = (cmd: string): boolean => {
    const name = commandName(cmd);
    return ROW_LOCAL_COMMANDS.has(name) && (name !== 'fillnull' || fillnullNamesFields(cmd));
};

/** stats functions whose result does not depend on the ORDER of the input rows
 *  (the staged rows come back in key order, not in arm order). list, first, last,
 *  earliest, latest, mode and the percentile estimators are not among them. */
export const ORDER_FREE_STATS: ReadonlySet<string> = new Set<string>([
    'count', 'c', 'dc', 'distinct_count', 'sum', 'sumsq', 'min', 'max', 'avg', 'mean', 'range', 'values',
    'stdev', 'stdevp', 'var', 'varp',
]);

export type StatsInputs = { ok: true; inputs: string[] } | { ok: false; reason: string };

/** Tokens of a stats clause: quoted strings, words, and single punctuation. */
const statsTokens = (s: string): string[] => s.match(/"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.:*$-]+|\S/g) || [];

/**
 * The fields a `stats` command reads, in a fixed order (function arguments
 * first, then the by-fields; each once). Only the simple form is accepted:
 * `stats fn(field) [as name] [, ...] [by f1, f2 ...]` with order-free functions
 * and plain field names, plus a bare `count` / `c`. Anything else - options,
 * eval() arguments, wildcards, quoted names, span= - is refused, so a tail the
 * panel cannot stage exactly is never staged approximately.
 */
export const parseStatsInputs = (cmd: string): StatsInputs => {
    if (commandName(cmd) !== 'stats') return { ok: false, reason: 'not a stats command' };
    const toks = statsTokens(cmd.trim().replace(/^stats\b/i, ''));
    const inputs: string[] = [];
    const add = (f: string): void => {
        if (inputs.indexOf(f) === -1) inputs.push(f);
    };
    let i = 0;
    let aggs = 0;
    let by = false;
    while (i < toks.length) {
        const t = toks[i];
        if (t === ',') {
            i += 1;
            continue;
        }
        if (/^by$/i.test(t)) {
            by = true;
            i += 1;
            break;
        }
        if (!SIMPLE_FIELD.test(t)) return { ok: false, reason: `unexpected "${t}" in the stats functions` };
        const fn = t.toLowerCase();
        if (toks[i + 1] === '=') return { ok: false, reason: `stats option ${t}= is not supported` };
        if (toks[i + 1] === '(') {
            const arg = toks[i + 2];
            if (toks[i + 3] !== ')' || typeof arg !== 'string') {
                return { ok: false, reason: `${t}(...) must take one plain field name` };
            }
            if (!SIMPLE_FIELD.test(arg)) return { ok: false, reason: `${t}(${arg}) does not name a plain field` };
            if (!ORDER_FREE_STATS.has(fn)) {
                return { ok: false, reason: `${fn}() depends on the order of the rows, which staging does not keep` };
            }
            add(arg);
            i += 4;
        } else {
            if (fn !== 'count' && fn !== 'c') return { ok: false, reason: `bare "${t}" is not a stats function` };
            i += 1;
        }
        aggs += 1;
        if (i < toks.length && /^as$/i.test(toks[i])) {
            const name = toks[i + 1];
            if (typeof name !== 'string' || !SIMPLE_FIELD.test(name)) {
                return { ok: false, reason: 'AS must be followed by a plain field name' };
            }
            i += 2;
        }
    }
    if (aggs === 0) return { ok: false, reason: 'stats has no function' };
    if (by) {
        let n = 0;
        for (; i < toks.length; i += 1) {
            const t = toks[i];
            if (t === ',') continue;
            if (!SIMPLE_FIELD.test(t) || toks[i + 1] === '=') {
                return { ok: false, reason: `"${t}" is not a plain by-field` };
            }
            add(t);
            n += 1;
        }
        if (n === 0) return { ok: false, reason: 'stats ... by names no field' };
    }
    const bad = inputs.filter((f) => /^lsv_/.test(f));
    if (bad.length > 0) return { ok: false, reason: `the field name ${bad[0]} is reserved for the stage` };
    /* The stage write drops _key (every staged row gets a fresh one) and the
     * combine search drops the stage's own: a stats that reads _key would see
     * none. */
    if (inputs.indexOf('_key') !== -1) return { ok: false, reason: 'stats reads _key, which staging does not keep' };
    if (inputs.length > STAGE_SLOTS) {
        return { ok: false, reason: `stats reads ${inputs.length} fields; the stage holds ${STAGE_SLOTS}` };
    }
    return { ok: true, inputs };
};

/** How a union backfill's tail can be dispatched. */
export type TailForm =
    /** Every command acts on one row at a time: `<arm> <tail>` per arm is exact. */
    | { kind: 'row_local' }
    /** The tail combines rows across arms at `stats`: stage, then combine. */
    | { kind: 'staged'; prefix: string[]; stats: string; rest: string[]; inputs: string[] }
    /** It combines rows in a way the panel cannot stage exactly: dispatch nothing. */
    | { kind: 'unsupported'; reason: string };

export const classifyTail = (tail: string): TailForm => {
    const cmds = splitCommands(tail);
    /* A per-arm (or per-part) dispatch writes its collection once per search, so
     * every write must upsert: an overwriting outputlookup would keep only the
     * last search's rows. */
    if (cmds.some((c) => commandName(c) === 'outputlookup' && !/\bappend\s*=\s*(t|true|1)\b/i.test(c))) {
        return { kind: 'unsupported', reason: 'its outputlookup overwrites the collection (no append=true)' };
    }
    let k = -1;
    for (let i = 0; i < cmds.length; i += 1) {
        if (!isRowLocal(cmds[i])) {
            k = i;
            break;
        }
    }
    if (k === -1) return { kind: 'row_local' };
    const name = commandName(cmds[k]);
    if (name === 'fillnull') {
        return { kind: 'unsupported', reason: 'its fillnull names no fields, so it fills the fields of every arm\'s rows' };
    }
    if (name !== 'stats') {
        return { kind: 'unsupported', reason: `its "${name || cmds[k]}" combines rows across arms and only stats can be staged` };
    }
    const prefix = cmds.slice(0, k);
    if (prefix.some((c) => commandName(c) === 'outputlookup')) {
        return { kind: 'unsupported', reason: 'it writes rows before it combines them' };
    }
    const parsed = parseStatsInputs(cmds[k]);
    if (!parsed.ok) return { kind: 'unsupported', reason: parsed.reason };
    return { kind: 'staged', prefix, stats: cmds[k], rest: cmds.slice(k + 1), inputs: parsed.inputs };
};

type StagedTail = Extract<TailForm, { kind: 'staged' }>;

/** A run id: 'r' + base-36 of the clock + 6 base-36 random characters. */
export const newRunId = (nowMs: number, rand01: number): string => {
    const r = Math.floor(Math.abs(rand01) * 2176782336) % 2176782336; // 36^6
    return `r${Math.floor(nowMs).toString(36)}${r.toString(36).padStart(6, '0')}`;
};

export const isPartId = (s: string): boolean => PART_ID.test(s);

/** One staged arm: the arm, the tail's row-local prefix, then only the fields the
 *  stats reads, renamed into the slots, appended to the stage under `part`.
 *  `fields <list>` keeps underscore fields, so the `_key` an arm or the prefix
 *  may set is dropped explicitly: with it, rows of other arms (or parts) that
 *  share its value would overwrite each other in the stage. Every staged row
 *  gets a fresh key. */
export const stageWriteSpl = (arm: string, form: StagedTail, part: string): string => {
    if (!isPartId(part)) throw new Error(`bad part id ${part}`);
    const renames = form.inputs.map((f, i) => `${f} as ${STAGE_SLOT_FIELDS[i]}`);
    const keep = [STAGE_PART_FIELD, STAGE_TIME_FIELD].concat(STAGE_SLOT_FIELDS.slice(0, form.inputs.length));
    return [arm].concat(form.prefix, [
        `eval ${STAGE_PART_FIELD}="${part}", ${STAGE_TIME_FIELD}=now()`,
    ], renames.length ? [`rename ${renames.join(', ')}`] : [], [
        `fields ${keep.join(', ')}`,
        'fields - _key',
        `outputlookup append=true override_if_empty=false ${STAGE_COLLECTION}`,
    ]).join(' | ');
};

/** The combine search for one part: read exactly that part back (a generating
 *  inputlookup - never a subsearch), restore the field names (`_time` as a
 *  number, as the arm produced it), then the stanza's own stats and the rest of
 *  its own tail. */
export const stageMergeSpl = (form: StagedTail, part: string): string => {
    if (!isPartId(part)) throw new Error(`bad part id ${part}`);
    const back: string[] = [];
    let timeSlot = '';
    form.inputs.forEach((f, i) => {
        if (f === '_time') timeSlot = STAGE_SLOT_FIELDS[i];
        else back.push(`${STAGE_SLOT_FIELDS[i]} as ${f}`);
    });
    const drop = ['_key', STAGE_PART_FIELD, STAGE_TIME_FIELD].concat(timeSlot ? [timeSlot] : []);
    return [`| inputlookup ${STAGE_COLLECTION} where ${STAGE_PART_FIELD}="${part}"`]
        .concat(back.length ? [`rename ${back.join(', ')}`] : [])
        .concat(timeSlot ? [`eval _time=tonumber(${timeSlot})`] : [])
        .concat([`fields - ${drop.join(', ')}`, form.stats], form.rest)
        .join(' | ');
};

/** One dispatchable unit (or a failure marker), in dispatch order. */
export interface PlannedItem {
    /** dispatch: `<arm> <tail>` or a whole single pipeline (as before build 378);
     *  stage: a staged arm; merge: a part's combine search; failed: nothing to
     *  dispatch (the row is marked failed). */
    kind: 'dispatch' | 'stage' | 'merge' | 'failed';
    /** '' for a failed item. */
    spl: string;
    /** 1-based over every arm of the rollup's stanzas; 0 for a merge. */
    armIndex: number;
    armCount: number;
    /** epoch seconds - this item's own window. */
    earliest: number;
    latest: number;
    /** "Jun 2025" when the window was split or the run has several windows. */
    chunkLabel: string;
    /** the part a stage / merge item belongs to; '' otherwise. */
    part: string;
    /** why a failed item failed; '' otherwise. */
    error: string;
}

export interface LoadedStanza {
    stanza: string;
    /** the stanza's search, or null when it could not be read. */
    spl: string | null;
}

/**
 * Expand one rollup's backfill stanzas into dispatch order.
 *
 * Stanzas whose tail is row-local (and single pipelines) are planned exactly as
 * before build 378: arm by arm, each arm over every window, each window split
 * by planChunks unless the stanza is pinned to the fixed 30 days. A staged
 * stanza is planned part by part instead: for each window and chunk, its arms,
 * then that part's merge - so a merge always follows every arm it waits for
 * (no worker can wait on an arm nobody has claimed), and the stage holds about
 * one chunk at a time.
 */
export const planRollupItems = (
    loaded: LoadedStanza[],
    wins: ResolvedWindow[],
    fixed30: ResolvedWindow,
    isPinned: (stanza: string) => boolean,
    nextPart: () => string,
): PlannedItem[] => {
    type Group =
        | { kind: 'plain'; arms: Array<{ spl: string; index: number }>; wins: ResolvedWindow[]; chunk: boolean }
        | { kind: 'staged'; arms: Array<{ spl: string; index: number }>; wins: ResolvedWindow[]; chunk: boolean; form: StagedTail }
        | { kind: 'unsupported'; firstIndex: number; wins: ResolvedWindow[]; reason: string; stanza: string };
    const groups: Group[] = [];
    let armCount = 0;
    loaded.forEach(({ stanza, spl }) => {
        if (!spl) return;
        const pinned = isPinned(stanza);
        const w = pinned ? [fixed30] : wins;
        const { arms: parsed, tail } = parseUnion(spl);
        if (parsed.length === 0) {
            armCount += 1;
            groups.push({ kind: 'plain', arms: [{ spl, index: armCount }], wins: w, chunk: !pinned });
            return;
        }
        /* An arm's own _key cannot key a staged row: stageWriteSpl drops it. */
        const form = classifyTail(tail);
        const first = armCount + 1;
        const arms = parsed.map((a) => {
            armCount += 1;
            return { spl: a, index: armCount };
        });
        if (form.kind === 'row_local') {
            groups.push({ kind: 'plain', arms: arms.map((a) => ({ spl: `${a.spl} ${tail}`, index: a.index })), wins: w, chunk: !pinned });
        } else if (form.kind === 'staged') {
            groups.push({ kind: 'staged', arms, wins: w, chunk: !pinned, form });
        } else {
            groups.push({ kind: 'unsupported', firstIndex: first, wins: w, reason: form.reason, stanza });
        }
    });
    const items: PlannedItem[] = [];
    if (armCount === 0) {
        items.push({
            kind: 'failed', spl: '', armIndex: 1, armCount: 1, earliest: wins[0].earliest, latest: wins[0].latest,
            chunkLabel: '', part: '', error: 'its saved search could not be read',
        });
        return items;
    }
    const unitsOf = (w: ResolvedWindow, chunk: boolean): Array<{ earliest: number; latest: number; label: string }> => {
        const chunks = chunk ? planChunks(w.earliest, w.latest) : [];
        return chunks.length > 1 ? chunks : [{ earliest: w.earliest, latest: w.latest, label: w.label }];
    };
    groups.forEach((g) => {
        if (g.kind === 'plain') {
            g.arms.forEach((arm) => {
                g.wins.forEach((w) => {
                    const units = unitsOf(w, g.chunk);
                    const named = units.length > 1 || g.wins.length > 1;
                    units.forEach((u) => {
                        items.push({
                            kind: 'dispatch', spl: arm.spl, armIndex: arm.index, armCount,
                            earliest: u.earliest, latest: u.latest, chunkLabel: named ? u.label : '', part: '', error: '',
                        });
                    });
                });
            });
        } else if (g.kind === 'staged') {
            g.wins.forEach((w) => {
                const units = unitsOf(w, g.chunk);
                const named = units.length > 1 || g.wins.length > 1;
                units.forEach((u) => {
                    const part = nextPart();
                    const chunkLabel = named ? u.label : '';
                    g.arms.forEach((arm) => {
                        items.push({
                            kind: 'stage', spl: stageWriteSpl(arm.spl, g.form, part), armIndex: arm.index, armCount,
                            earliest: u.earliest, latest: u.latest, chunkLabel, part, error: '',
                        });
                    });
                    items.push({
                        kind: 'merge', spl: stageMergeSpl(g.form, part), armIndex: 0, armCount,
                        earliest: u.earliest, latest: u.latest, chunkLabel, part, error: '',
                    });
                });
            });
        } else {
            items.push({
                kind: 'failed', spl: '', armIndex: g.firstIndex, armCount, earliest: g.wins[0].earliest,
                latest: g.wins[0].latest, chunkLabel: '', part: '',
                error: `${g.stanza} cannot be split into top-level searches exactly: ${g.reason}`,
            });
        }
    });
    return items;
};

/** A part may be combined only when every one of its arms reported done. */
export const mergeAllowed = (verdicts: ArmVerdict[], armTotal: number): boolean =>
    armTotal > 0 && verdicts.length === armTotal && verdicts.every((v) => v === 'done');

/** How a part's combine step ended. 'skipped' = the combine search was never
 *  dispatched (an arm did not finish cleanly); 'unreconciled' = the stage did
 *  not hold exactly the rows the arms wrote, before or after the combine. */
export type MergeOutcome = ArmVerdict | 'skipped' | 'unreconciled';

/** After a part is settled: may its staged rows be deleted now? Not while a
 *  combine search the panel stopped waiting for may still be reading them - that
 *  search writes its rows when it finishes, like any detached search, and needs
 *  the whole part - and not when the part did not reconcile: those rows are the
 *  evidence, and the orphan sweep removes them after STAGE_ORPHAN_AGE_SECONDS. */
export const stageDeletable = (merge: MergeOutcome): boolean => merge !== 'detached' && merge !== 'unreconciled';

/** What a combine step contributes to its row's outcome: a part that was not
 *  combined, or did not reconcile, wrote nothing it can vouch for - failed. */
export const mergeRowVerdict = (merge: MergeOutcome): ArmVerdict =>
    (merge === 'skipped' || merge === 'unreconciled' ? 'failed' : merge);

/** What a staged arm contributes to its row's outcome: an arm the panel stopped
 *  waiting for is never combined, so - unlike a plain arm, which writes its rows
 *  when it finishes - it is a failure to re-run, not "still running". */
export const stagedArmRowVerdict = (v: ArmVerdict): ArmVerdict => (v === 'detached' ? 'failed' : v);

/** KV REST query (JSON) selecting one part's staged rows. */
export const partQuery = (part: string): Record<string, unknown> => ({ [STAGE_PART_FIELD]: part });

/** KV REST query selecting staged rows old enough to belong to no live part.
 *  The bound is a JSON NUMBER: the field is a KV number (session-103 sticky).
 *  `nowSec` must be the SERVER's clock (serverClockSec): lsv_staged_at was
 *  written by the server's now(), and a browser clock days fast would sweep a
 *  part another run is still combining. */
export const orphanQuery = (nowSec: number): Record<string, unknown> => ({
    [STAGE_TIME_FIELD]: { $lt: Math.floor(nowSec) - STAGE_ORPHAN_AGE_SECONDS },
});

/** The server's clock in epoch seconds, from an HTTP `Date` response header,
 *  or null when there is no usable one (the panel then skips the orphan sweep:
 *  leaving scratch rows costs storage, sweeping by the wrong clock costs data). */
export const serverClockSec = (dateHeader: string | null | undefined): number | null => {
    if (typeof dateHeader !== 'string' || !dateHeader.trim()) return null;
    const ms = Date.parse(dateHeader);
    if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1)) return null;
    return Math.floor(ms / 1000);
};

/* ------------------------- accounting for every staged row ------------------------- */

/** A non-negative whole count, as a JSON number or a decimal string; else null. */
const strictCount = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
    if (typeof v === 'string' && /^\s*[0-9]{1,15}\s*$/.test(v)) return Number(v.trim());
    return null;
};

/** What a finished job's entry (GET search/jobs/<sid>) proves about its output. */
export type JobFacts = { ok: true; resultCount: number } | { ok: false; reason: string };

/** Read a finished job's entry: no ERROR or FATAL message, finished, and a
 *  result count. A search ending in outputlookup returns the rows it wrote, so
 *  for a staged arm the count is the number of rows it staged. Anything less
 *  proves nothing, and a staged arm or a combine search that proves nothing is
 *  a failure (fail closed). */
export const readJobFacts = (httpStatus: number, body: unknown): JobFacts => {
    if (httpStatus < 200 || httpStatus >= 300) return { ok: false, reason: `its job could not be read (HTTP ${httpStatus})` };
    const c = (body as { entry?: Array<{ content?: unknown }> } | null | undefined)?.entry?.[0]?.content;
    if (!c || typeof c !== 'object') return { ok: false, reason: 'its job could not be read' };
    const content = c as Record<string, unknown>;
    const msgs = Array.isArray(content.messages) ? (content.messages as unknown[]) : [];
    for (const m of msgs) {
        const type = String((m as { type?: unknown } | null)?.type ?? '').toUpperCase();
        if (type === 'ERROR' || type === 'FATAL') {
            const text = String((m as { text?: unknown } | null)?.text ?? '').trim();
            return { ok: false, reason: `Splunk reported ${type}: ${text || '(no text)'}` };
        }
    }
    const done = content.isDone === true || content.isDone === 1 || content.isDone === '1' || content.isDone === 'true';
    if (!done) return { ok: false, reason: 'its job had not finished' };
    const n = strictCount(content.resultCount);
    if (n === null) return { ok: false, reason: 'its job reported no result count' };
    return { ok: true, resultCount: n };
};

/** A staged arm's contribution to its part: done only with readable facts,
 *  and then the rows it staged. */
export const stagedArmResult = (v: ArmVerdict, facts: JobFacts): { verdict: ArmVerdict; rows: number; reason: string } => {
    if (v !== 'done') return { verdict: v, rows: 0, reason: '' };
    return facts.ok ? { verdict: 'done', rows: facts.resultCount, reason: '' } : { verdict: 'failed', rows: 0, reason: facts.reason };
};

/** A combine search that ended DONE with an ERROR message (its write failed,
 *  or `require` stopped it) is a failure. */
export const mergeJobVerdict = (v: ArmVerdict, facts: JobFacts): ArmVerdict => (v === 'done' && !facts.ok ? 'failed' : v);

/** The count search for one part: how many rows the stage holds for it. A
 *  generating inputlookup (never a subsearch) and one stats row. */
export const stageCountSpl = (part: string): string => {
    if (!isPartId(part)) throw new Error(`bad part id ${part}`);
    return `| inputlookup ${STAGE_COLLECTION} where ${STAGE_PART_FIELD}="${part}" | stats count as n`;
};

/** One attempt at a part's count (a oneshot of stageCountSpl). */
export type PartCountAttempt =
    | { kind: 'ok'; n: number }
    | { kind: 'busy'; reason: string }
    | { kind: 'failed'; reason: string };

/** Classify the count oneshot's response: the history check's rules (a busy
 *  search head, an ERROR message), plus a count that must be there - `stats
 *  count` always answers one row, so a missing number is a failed read, not 0. */
export const classifyPartCount = (httpStatus: number, body: unknown): PartCountAttempt => {
    const a = classifyCheckResponse(httpStatus, body);
    if (a.kind !== 'ok') return a;
    const results = (body as { results?: unknown[] }).results as unknown[];
    const n = strictCount((results[0] as { n?: unknown } | undefined)?.n);
    return n === null ? { kind: 'failed', reason: 'the count came back without a number' } : { kind: 'ok', n };
};

/** Waits before counting a part again: a KV Store warming up after a restart
 *  or a replica catching up answers short or empty for a while. */
export const PART_COUNT_RETRY_DELAYS_MS: readonly number[] = [5000, 15000, 30000];

export type PartCountDecision =
    | { kind: 'match' }
    | { kind: 'retry'; delayMs: number }
    | { kind: 'mismatch'; reason: string };

/** Does the stage hold exactly the `expected` rows the part's arms wrote?
 *  `attempts` counts the attempts made, this one included. Short, empty, over
 *  or unreadable: retried with PART_COUNT_RETRY_DELAYS_MS, then a mismatch. */
export const decidePartCount = (a: PartCountAttempt, expected: number, attempts: number): PartCountDecision => {
    if (!Number.isSafeInteger(expected) || expected < 0) return { kind: 'mismatch', reason: 'no expected row count' };
    if (a.kind === 'ok' && a.n === expected) return { kind: 'match' };
    const used = Math.max(0, attempts - 1);
    if (used < PART_COUNT_RETRY_DELAYS_MS.length) return { kind: 'retry', delayMs: PART_COUNT_RETRY_DELAYS_MS[used] };
    return {
        kind: 'mismatch',
        reason: a.kind === 'ok'
            ? `its searches staged ${expected} rows and ${a.n} read back`
            : `its ${expected} staged rows could not be counted (${a.reason})`,
    };
};

/** The combine search as dispatched: when the part's arms staged rows, an
 *  empty read must FAIL the search rather than write nothing and finish -
 *  `require` right after the read (it fails a search whose preceding commands
 *  return no results). With nothing staged, the combine runs as planned (a
 *  stats with no by-clause still writes its one row, as the union would). */
export const guardedMergeSpl = (mergeSpl: string, part: string, expected: number): string => {
    if (!isPartId(part)) throw new Error(`bad part id ${part}`);
    const head = `| inputlookup ${STAGE_COLLECTION} where ${STAGE_PART_FIELD}="${part}"`;
    if (!mergeSpl.startsWith(`${head} | `)) throw new Error(`not the combine search of part ${part}`);
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error(`bad expected row count ${expected}`);
    return expected > 0 ? `${head} | require | ${mergeSpl.slice(head.length + 3)}` : mergeSpl;
};
