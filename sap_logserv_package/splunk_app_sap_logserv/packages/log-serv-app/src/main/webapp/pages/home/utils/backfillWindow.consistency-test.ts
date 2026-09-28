/**
 * Build-time consistency test for the custom backfill window (session 131).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - The CHUNK COVER is what makes chunking safe at all. If chunks overlap, an
 *    hourly bucket is aggregated twice; if they gap, an hour is never built and
 *    the dashboard shows a hole nobody notices. Contiguity, ordering and exact
 *    coverage of [earliest, latest) are asserted directly, across month lengths
 *    28/29/30/31 and a year boundary.
 *  - Chunk boundaries must land on DAY boundaries. That is the property the
 *    day-scoped rollups (beaconing, beaconing_detail) depend on — their
 *    streamstats is scoped `by ..., day, ...`, so a chunk edge inside a day
 *    would split the inter-arrival computation and silently change the answer.
 *  - The window end must snap to the HOUR, never the day. A `@d` end discards
 *    every bucket built so far today (standing project sticky).
 *  - Everything is UTC. The clock is FROZEN inside the hours where the local
 *    and UTC dates disagree, because a `getMonth()`-for-`getUTCMonth()` slip is
 *    invisible for ~99% of the year and this suite would otherwise pass on a
 *    lucky run date (session-128 sticky 12).
 *  - The retention floor must REJECT rather than clamp: a silent clamp reports
 *    success for a window it did not do.
 *  - (session 132) The DAY COUNT must not depend on the hour of day -- build
 *    353's rounded span read "last 30 days -- 31 day(s)" after noon UTC and
 *    toggled the cost warning on the 90-day preset -- and a window no longer
 *    than a month must be dispatched WHOLE (planChunks).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const bwProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const bw = require('./backfillWindow') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const {
    resolveWindow,
    monthChunks,
    planChunks,
    isCostlyWindow,
    COST_WARNING_DAYS,
    MAX_UNCHUNKED_DAYS,
    parseUtcDate,
    toUtcDateString,
    RETENTION_DAYS,
    DEFAULT_PRESET_DAYS,
    PRESET_DAYS,
} = bw;

let bwFailures = 0;
let bwChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    bwChecks += 1;
    if (!ok) {
        bwFailures += 1;
        bwProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};
const eq = (label: string, actual: unknown, expected: unknown): void =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const MS_DAY = 86400000;
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/* A clock inside the window where the LOCAL date and the UTC date disagree for
 * every timezone west of Greenwich: 02:00Z on the 1st. If any accessor in the
 * module is `getMonth`/`getDate` instead of the UTC form, these assertions move. */
const T_UTC_TRAP = Date.UTC(2026, 8, 1, 2, 0, 0); // 2026-09-01T02:00:00Z

/* =============================================================================
 * A. UTC correctness — the failure mode that hides for 99% of the year
 * ========================================================================== */

{
    const r = resolveWindow({ kind: 'preset', days: 30 }, T_UTC_TRAP);
    check('A1 preset resolves at the UTC-trap clock', r.ok, JSON.stringify(r));
    if (r.ok) {
        eq('A2 earliest is the UTC day 30 days back', iso(r.window.earliest),
            '2026-08-02T00:00:00.000Z');
        eq('A3 latest snaps to the UTC hour, not the day', iso(r.window.latest),
            '2026-09-01T02:00:00.000Z');
    }
}
check('A4 latest is NEVER day-snapped (would discard today\'s buckets)',
    (() => {
        const r = resolveWindow({ kind: 'preset', days: 30 }, T_UTC_TRAP);
        return r.ok && r.window.latest * 1000 !== Date.UTC(2026, 8, 1);
    })(),
    'a @d end silently drops every bucket built so far today');

/* =============================================================================
 * B. Custom range — inclusivity, validation, unreal dates
 * ========================================================================== */

{
    const r = resolveWindow(
        { kind: 'custom', from: '2025-06-01', to: '2025-06-30' },
        Date.UTC(2026, 0, 15, 12),
    );
    check('B1 custom range resolves', r.ok, JSON.stringify(r));
    if (r.ok) {
        eq('B2 from is UTC midnight of the from-date', iso(r.window.earliest),
            '2025-06-01T00:00:00.000Z');
        eq('B3 to is END-exclusive at the next day — the whole to-date is included',
            iso(r.window.latest), '2025-07-01T00:00:00.000Z');
        eq('B4 day span', r.window.days, 30);
    }
}
/* Deliberately a RECENT unreal date, and the error text is asserted too.
 * The first version of this check used 2025-02-30 against Date.now(), which
 * still reported !ok after the date guard was removed — because the rolled-over
 * date then tripped the RETENTION floor instead. It passed for the wrong
 * reason, and only mutation testing showed it (session-131). */
{
    const now = Date.UTC(2026, 2, 15, 12); // 2026-03-15, so Feb 2026 is inside retention
    const r = resolveWindow({ kind: 'custom', from: '2026-02-30', to: '2026-03-05' }, now);
    check('B5 an unreal date is rejected, not rolled into the next month', !r.ok,
        'Date.UTC(2026,1,30) silently becomes 2 March');
    check('B5b rejected BY THE DATE GUARD, not incidentally by the retention floor',
        !r.ok && /YYYY-MM-DD/.test(r.error),
        !r.ok ? `wrong branch: ${r.error}` : 'accepted');
}
check('B6 a malformed date is rejected',
    !resolveWindow({ kind: 'custom', from: '01/06/2025', to: '2025-06-30' }, Date.now()).ok,
    'only YYYY-MM-DD is accepted');
check('B7 an inverted range is rejected',
    !resolveWindow({ kind: 'custom', from: '2025-06-30', to: '2025-06-01' }, Date.now()).ok,
    'end before start');
check('B8 a same-day range is rejected as empty only if it spans nothing',
    resolveWindow({ kind: 'custom', from: '2025-06-01', to: '2025-06-01' },
        Date.UTC(2026, 0, 1)).ok,
    'from==to means that single whole day, which is a valid 1-day window');
check('B9 a future end is clamped to now, not refused',
    (() => {
        const now = Date.UTC(2026, 8, 1, 2, 0, 0);
        const r = resolveWindow({ kind: 'custom', from: '2026-08-01', to: '2099-01-01' }, now);
        return r.ok && r.window.latest * 1000 === now;
    })(),
    'asking past "now" is a typo, not an error worth blocking on');

/* =============================================================================
 * C. Retention floor — reject, never clamp
 * ========================================================================== */

{
    const now = Date.UTC(2026, 8, 23, 12);
    const tooOld = toUtcDateString(now - (RETENTION_DAYS + 5) * MS_DAY);
    const r = resolveWindow({ kind: 'custom', from: tooOld, to: '2026-09-20' }, now);
    check('C1 a start older than retention is REJECTED', !r.ok, JSON.stringify(r));
    check('C2 the rejection names the earliest usable date',
        !r.ok && /Earliest usable date is \d{4}-\d{2}-\d{2}/.test(r.error), !r.ok ? r.error : '');
    const ok = resolveWindow({ kind: 'preset', days: RETENTION_DAYS }, now);
    check('C3 the 365-day preset itself is still allowed', ok.ok, JSON.stringify(ok));
}

/* =============================================================================
 * D. Chunk cover — the property that makes chunking safe
 * ========================================================================== */

const coverCheck = (label: string, fromIso: string, toIso: string, expectCount: number): void => {
    const e = Math.floor(Date.parse(fromIso) / 1000);
    const l = Math.floor(Date.parse(toIso) / 1000);
    const chunks = monthChunks(e, l);
    check(`${label} chunk count`, chunks.length === expectCount,
        `got ${chunks.length}, expected ${expectCount}`);
    if (!chunks.length) return;
    check(`${label} starts at the window start`, chunks[0].earliest === e,
        `${iso(chunks[0].earliest)} vs ${fromIso}`);
    check(`${label} ends at the window end`, chunks[chunks.length - 1].latest === l,
        `${iso(chunks[chunks.length - 1].latest)} vs ${toIso}`);
    let contiguous = true;
    let ordered = true;
    let dayAligned = true;
    for (let i = 0; i < chunks.length; i += 1) {
        if (chunks[i].latest <= chunks[i].earliest) ordered = false;
        if (i > 0 && chunks[i].earliest !== chunks[i - 1].latest) contiguous = false;
        // interior boundaries must sit on a UTC day boundary
        if (i > 0 && (chunks[i].earliest * 1000) % MS_DAY !== 0) dayAligned = false;
    }
    check(`${label} chunks are contiguous (no gap, no overlap)`, contiguous, 'boundary mismatch');
    check(`${label} chunks are ordered and non-empty`, ordered, 'a chunk ends before it starts');
    check(`${label} interior boundaries are DAY-aligned`, dayAligned,
        'a boundary inside a day would split the day-scoped beaconing streamstats');
};

coverCheck('D1 Feb (28d) non-leap', '2025-02-01T00:00:00Z', '2025-03-01T00:00:00Z', 1);
coverCheck('D2 Feb (29d) leap', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z', 1);
coverCheck('D3 30-day month', '2025-06-01T00:00:00Z', '2025-07-01T00:00:00Z', 1);
coverCheck('D4 31-day month', '2025-07-01T00:00:00Z', '2025-08-01T00:00:00Z', 1);
coverCheck('D5 across a year boundary', '2025-11-15T00:00:00Z', '2026-02-10T00:00:00Z', 4);
coverCheck('D6 partial month at both ends', '2025-06-15T00:00:00Z', '2025-08-20T00:00:00Z', 3);
coverCheck('D7 a full 365-day window', '2025-09-23T00:00:00Z', '2026-09-23T00:00:00Z', 13);
coverCheck('D8 sub-month window is one chunk', '2025-06-10T00:00:00Z', '2025-06-20T00:00:00Z', 1);
coverCheck('D9 hour-aligned end mid-month', '2026-09-01T00:00:00Z', '2026-09-23T14:00:00Z', 1);

check('D10 an empty or inverted window yields no chunks',
    monthChunks(100, 100).length === 0 && monthChunks(200, 100).length === 0,
    'a zero-length window must not produce a chunk');

check('D11 chunk labels name a month an operator can re-run',
    (() => {
        const c = monthChunks(
            Math.floor(Date.parse('2025-11-15T00:00:00Z') / 1000),
            Math.floor(Date.parse('2026-01-05T00:00:00Z') / 1000),
        );
        return c.length === 3 && c[0].label === 'Nov 2025' && c[2].label === 'Jan 2026';
    })(),
    'labels must carry the year so Jan 2026 is not confused with Jan 2025');

/* The cover property, restated as a sum: the chunks' total duration must equal
 * the window's, which fails if any pair overlaps or gaps. */
check('D12 chunk durations sum to exactly the window duration',
    (() => {
        const e = Math.floor(Date.parse('2025-03-07T00:00:00Z') / 1000);
        const l = Math.floor(Date.parse('2026-02-11T00:00:00Z') / 1000);
        const c = monthChunks(e, l);
        let sum = 0;
        for (let i = 0; i < c.length; i += 1) sum += c[i].latest - c[i].earliest;
        return sum === l - e;
    })(),
    'overlap would over-sum, a gap would under-sum');

/* =============================================================================
 * E. Defaults + depth label
 * ========================================================================== */

eq('E1 the default preset is the pre-session-131 window', DEFAULT_PRESET_DAYS, 30);
check('E2 the default preset is offered in the list', PRESET_DAYS.indexOf(30) >= 0, 'missing 30');
check('E3 the retention-length preset is offered', PRESET_DAYS.indexOf(RETENTION_DAYS) >= 0,
    'the longest usable window must be reachable in one click');

eq('E4 parseUtcDate round-trips through toUtcDateString',
    toUtcDateString(parseUtcDate('2025-06-01') as number), '2025-06-01');

/* =============================================================================
 * F. The day count is DETERMINISTIC (session 132)
 *
 * Every clock below is a different hour of the SAME UTC day, so any dependence
 * on the hour moves an assertion. 00:30 and 12:30 bracket the old Math.round
 * flip; 00:30 is also the one hour a to-today custom range legitimately loses a
 * day (F8).
 * ========================================================================== */

const HOURS_OF_ONE_DAY: number[] = [0, 1, 11, 12, 13, 22, 23].map(
    (h) => Date.UTC(2026, 8, 23, h, 30, 0),
);
const presetDaysAt = (n: number, t: number): unknown => {
    const r = resolveWindow({ kind: 'preset', days: n }, t);
    return r.ok ? r.window.days : 'rejected';
};

for (const n of PRESET_DAYS as number[]) {
    check(`F1 preset ${n} reports ${n} day(s) at every hour of the day`,
        HOURS_OF_ONE_DAY.every((t) => presetDaysAt(n, t) === n),
        HOURS_OF_ONE_DAY.map((t) => String(presetDaysAt(n, t))).join(','));
}
check('F2 the 90-day preset NEVER warns, morning or afternoon',
    HOURS_OF_ONE_DAY.every((t) => {
        const r = resolveWindow({ kind: 'preset', days: 90 }, t);
        return r.ok && !isCostlyWindow(r.window);
    }),
    'build 353 warned on it after 12:00 UTC only');
check('F3 the 180- and 365-day presets ALWAYS warn',
    HOURS_OF_ONE_DAY.every((t) => [180, 365].every((n) => {
        const r = resolveWindow({ kind: 'preset', days: n }, t);
        return r.ok && isCostlyWindow(r.window);
    })),
    'a half-year or year rebuild must always carry the warning');
eq('F4 the warning threshold is the documented 90 days', COST_WARNING_DAYS, 90);

{
    const at = (h: number): number => Date.UTC(2026, 8, 23, h, 30, 0);
    const days = (from: string, to: string, t: number): number => {
        const r = resolveWindow({ kind: 'custom', from, to }, t);
        return r.ok ? r.window.days : -1;
    };
    eq('F5 a past custom range reports its inclusive day count',
        days('2026-09-01', '2026-09-10', at(13)), 10);
    eq('F6 ...identically in the morning and the evening',
        [days('2026-09-01', '2026-09-10', at(1)), days('2026-09-01', '2026-09-10', at(23))], [10, 10]);
    eq('F7 a range ending TODAY counts today, morning and evening',
        [days('2026-09-13', '2026-09-23', at(1)), days('2026-09-13', '2026-09-23', at(23))], [11, 11]);
    /* ...INCLUDING the 00:xx hour. Build 354 counted from the window's last
     * instant; the end snaps to the hour, so at 00:30 a range ending today had
     * no complete hour of today in it and read one day short. The count now
     * follows the NAMED dates. */
    eq('F8 ...including the 00:xx hour (the count follows the named dates)',
        days('2026-09-13', '2026-09-23', at(0)), 11);
    eq('F10 a future end counts only through today',
        days('2026-09-13', '2099-01-01', at(13)), 11);
    /* The exact scenario that exposed it: the panel's own prefill
     * (today - 30 .. today) viewed in the 00:xx hour. */
    eq('F11 the panel prefill read at 00:30 counts all 31 named dates',
        days('2026-08-24', '2026-09-23', at(0)), 31);
    check('F9 a 91-day custom range warns and a 90-day one does not',
        (() => {
            const a = resolveWindow({ kind: 'custom', from: '2026-06-01', to: '2026-08-30' }, at(13));
            const b = resolveWindow({ kind: 'custom', from: '2026-06-01', to: '2026-08-29' }, at(13));
            return a.ok && b.ok && a.window.days === 91 && isCostlyWindow(a.window)
                && b.window.days === 90 && !isCostlyWindow(b.window);
        })(),
        'the inclusive count is what drives the threshold');
}

/* =============================================================================
 * G. planChunks -- a window no longer than a month is dispatched WHOLE (session 132)
 * ========================================================================== */

const secs = (isoStr: string): number => Math.floor(Date.parse(isoStr) / 1000);

eq('G1 the threshold is the longest calendar month', MAX_UNCHUNKED_DAYS, 31);
{
    const r = resolveWindow({ kind: 'preset', days: DEFAULT_PRESET_DAYS }, T_UTC_TRAP);
    const c = r.ok ? planChunks(r.window.earliest, r.window.latest) : [];
    check('G2 the 30-day default across a month boundary is ONE unit', c.length === 1,
        `got ${c.length}`);
    check('G3 ...covering exactly the window, unlabelled',
        r.ok && c.length === 1 && c[0].earliest === r.window.earliest
            && c[0].latest === r.window.latest && c[0].label === '',
        JSON.stringify(c));
    check('G4 CONTROL: monthChunks alone WOULD split this window',
        r.ok && monthChunks(r.window.earliest, r.window.latest).length === 2,
        'if this window does not cross a month boundary, G2 proves nothing');
}
check('G5 the 30-day default is ONE unit at every hour of a day',
    HOURS_OF_ONE_DAY.every((t) => {
        const r = resolveWindow({ kind: 'preset', days: 30 }, t);
        return r.ok && planChunks(r.window.earliest, r.window.latest).length === 1;
    }),
    'a 30-day preset spans at most 30 days 23 hours');
check('G6 exactly 31 days stays whole',
    planChunks(secs('2025-06-15T00:00:00Z'), secs('2025-07-16T00:00:00Z')).length === 1,
    'the threshold is inclusive');
check('G7 31 days plus one hour is chunked by month',
    planChunks(secs('2025-06-15T00:00:00Z'), secs('2025-07-16T01:00:00Z')).length === 2,
    'just past the threshold falls through to monthChunks');
{
    const at = Date.UTC(2026, 8, 23, 22, 0, 0);
    for (const n of [60, 90, 180, 365]) {
        const r = resolveWindow({ kind: 'preset', days: n }, at);
        const p = r.ok ? planChunks(r.window.earliest, r.window.latest) : [];
        const m = r.ok ? monthChunks(r.window.earliest, r.window.latest) : [];
        check(`G8 a ${n}-day window is chunked exactly as monthChunks does`,
            r.ok && p.length > 1 && JSON.stringify(p) === JSON.stringify(m),
            `plan=${p.length} month=${m.length}`);
    }
}
check('G9 an empty or inverted window yields no units',
    planChunks(100, 100).length === 0 && planChunks(200, 100).length === 0,
    'a zero-length window must not dispatch');

/* ===================================================================== */

if (bwFailures > 0) {
    bwProc.stderr.write(`\nbackfillWindow.consistency-test: ${bwFailures} failure(s) of ${bwChecks}\n`);
    bwProc.exit(1);
}
console.log(`backfillWindow.consistency-test: OK (${bwChecks} checks)`);
