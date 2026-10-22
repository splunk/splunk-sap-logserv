/**
 * Build-time consistency test for the late-arriving data check (session 147).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - The WINDOW. Its start is the later of LATE_CHECK_DAYS ago (UTC midnight)
 *    and the rollup's oldest bucket - before that bucket the rollup was never
 *    built, so every older hour would read as "late" and the panel would offer
 *    to rebuild history nobody lost. Its end is LATE_CHECK_SETTLE_HOURS before
 *    the current hour: a younger bucket can still be rewritten by the two-hour
 *    re-scan, so judging it would report delays the schedule is about to fix.
 *    An empty rollup gives no window at all.
 *  - The PARSER drops what it cannot trust (a non-midnight day, a zero or
 *    negative count, garbage) instead of guessing, merges a day that comes back
 *    twice, and takes sourcetypes as Splunk sends them (a string for one value,
 *    an array for several).
 *  - The RANGES that the one-click rebuild dispatches cover exactly the listed
 *    days: consecutive days merge, a gap splits, nothing outside the list is
 *    touched. The windows resolve through backfillWindow.resolveWindow, so they
 *    are UTC whole days ending at the next midnight, or at the current hour for
 *    today - and a range older than the retention floor fails the whole set.
 *  - Everything is UTC under a frozen clock set where the local and UTC dates
 *    disagree (session-128 sticky 12).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const laProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const la = require('./lateArrivals') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const {
    lateCheckWindow,
    parseLateRows,
    dayRanges,
    lateBackfillWindows,
    describeLateDay,
    summarizeLate,
    fmtCount,
    LATE_CHECK_DAYS,
    LATE_CHECK_SETTLE_HOURS,
    LATE_CHECK_STANZA,
    LATE_CHECK_ROLLUP_KEY,
} = la;

let laFailures = 0;
let laChecks = 0;
const check = (name: string, cond: boolean, detail: string): void => {
    laChecks += 1;
    if (!cond) {
        laFailures += 1;
        laProc.stderr.write(`FAIL ${name}: ${detail}\n`);
    }
};

const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const H = 3600;
const D = 86400;

/* A frozen clock at 02:40 UTC: in every zone west of UTC the local date is
 * still the day before. */
const NOW = Date.parse('2026-10-01T02:40:00Z');

/* ============================ A. constants ============================ */

check('A1 stanza name', LATE_CHECK_STANZA === 'logserv_late_arrival_check', String(LATE_CHECK_STANZA));
check('A2 compared rollup', LATE_CHECK_ROLLUP_KEY === 'mc', String(LATE_CHECK_ROLLUP_KEY));
check('A3 30 days', LATE_CHECK_DAYS === 30, String(LATE_CHECK_DAYS));
check('A4 settle 3 hours', LATE_CHECK_SETTLE_HOURS === 3,
    'the two-hour re-scan finishes by H+2h+28m; 3 whole hours is the first settled edge');

/* ============================ B. window ============================ */
{
    const w = lateCheckWindow(NOW, Date.parse('2026-06-01T00:00:00Z'));
    check('B1 a deep rollup starts LATE_CHECK_DAYS back at UTC midnight',
        !!w && w.earliest === secs('2026-09-01T00:00:00Z'), JSON.stringify(w));
    check('B2 the end is the current hour minus 3 hours',
        !!w && w.latest === secs('2026-09-30T23:00:00Z'), JSON.stringify(w));
    check('B3 the window is hour-aligned at both ends',
        !!w && w.earliest % H === 0 && w.latest % H === 0, JSON.stringify(w));
}
{
    const w = lateCheckWindow(NOW, Date.parse('2026-09-24T01:00:00Z'));
    check('B4 a shallow rollup starts at its oldest bucket',
        !!w && w.earliest === secs('2026-09-24T01:00:00Z'), JSON.stringify(w));
}
{
    const w = lateCheckWindow(NOW, Date.parse('2026-09-24T01:30:00Z'));
    check('B5 a mid-hour oldest instant rounds UP to the next bucket',
        !!w && w.earliest === secs('2026-09-24T02:00:00Z'), JSON.stringify(w));
}
check('B6 an empty rollup gives no window', lateCheckWindow(NOW, 0) === null, 'oldest 0 = empty');
check('B7 a rollup younger than the settle edge gives no window',
    lateCheckWindow(NOW, Date.parse('2026-09-30T23:00:00Z')) === null
    && lateCheckWindow(NOW, Date.parse('2026-10-01T01:00:00Z')) === null,
    'nothing settled to judge');
check('B8 one settled hour is a window',
    JSON.stringify(lateCheckWindow(NOW, Date.parse('2026-09-30T22:00:00Z')))
    === JSON.stringify({ earliest: secs('2026-09-30T22:00:00Z'), latest: secs('2026-09-30T23:00:00Z') }),
    'the last settled bucket is in');
check('B9 a negative or NaN oldest gives no window',
    lateCheckWindow(NOW, -5) === null && lateCheckWindow(NOW, NaN) === null, 'guard');
{
    /* the end does not move within an hour, and moves by exactly an hour */
    const a = lateCheckWindow(Date.parse('2026-10-01T02:00:00Z'), Date.parse('2026-06-01T00:00:00Z'));
    const b = lateCheckWindow(Date.parse('2026-10-01T02:59:59Z'), Date.parse('2026-06-01T00:00:00Z'));
    const c = lateCheckWindow(Date.parse('2026-10-01T03:00:00Z'), Date.parse('2026-06-01T00:00:00Z'));
    check('B10 the end steps once per hour',
        !!a && !!b && !!c && a.latest === b.latest && c.latest === a.latest + H,
        JSON.stringify([a, b, c]));
}

/* ============================ C. parser ============================ */
{
    const rows = parseLateRows([
        { day_ts: String(secs('2026-09-27T00:00:00Z')), missing: '13138', hours: '15', sourcetypes: ['sap_logserv_logs', 'linux_secure'] },
        { day_ts: String(secs('2026-09-26T00:00:00Z')), missing: '28193', hours: '42', sourcetypes: 'linux_secure' },
        { day_ts: String(secs('2026-09-25T00:00:00Z') + 3600), missing: '5', hours: '1', sourcetypes: 'x' },
        { day_ts: String(secs('2026-09-24T00:00:00Z')), missing: '0', hours: '0', sourcetypes: 'x' },
        { day_ts: String(secs('2026-09-23T00:00:00Z')), missing: '-4', hours: '1', sourcetypes: 'x' },
        { day_ts: 'garbage', missing: '9', hours: '1' },
        null,
        { day_ts: String(secs('2026-09-27T00:00:00Z')), missing: '2', hours: '1', sourcetypes: ['who', 'linux_secure'] },
    ]);
    check('C1 only whole UTC days with a positive count survive, sorted, each once',
        rows.length === 2
        && rows[0].dayTs === secs('2026-09-26T00:00:00Z')
        && rows[1].dayTs === secs('2026-09-27T00:00:00Z'),
        JSON.stringify(rows));
    check('C2 a single sourcetype string is a one-element list',
        rows.length > 0 && JSON.stringify(rows[0].sourcetypes) === '["linux_secure"]', JSON.stringify(rows[0]));
    check('C3 a repeated day merges counts, hours and sourcetypes',
        rows.length > 1 && rows[1].missing === 13140 && rows[1].hours === 16
        && JSON.stringify(rows[1].sourcetypes) === '["linux_secure","sap_logserv_logs","who"]',
        JSON.stringify(rows[1]));
    check('C4 numbers are numbers', rows.length > 0 && typeof rows[0].missing === 'number', JSON.stringify(rows[0]));
}
check('C5 no results array is no days',
    parseLateRows(undefined).length === 0 && parseLateRows({}).length === 0 && parseLateRows([]).length === 0,
    'never throws');
{
    const r = parseLateRows([{ day_ts: String(secs('2026-09-26T00:00:00Z')), missing: '7' }]);
    check('C6 a missing hours / sourcetypes field reads as 0 / none',
        r.length === 1 && r[0].hours === 0 && r[0].sourcetypes.length === 0, JSON.stringify(r));
}

{
    const r = parseLateRows([{ day_ts: String(secs('2026-09-26T00:00:00Z')), missing: '3', hours: '1', sourcetypes: ['who', 'linux_secure', 'who'] }]);
    check('C7 one row: its sourcetypes come back sorted and each once',
        r.length === 1 && JSON.stringify(r[0].sourcetypes) === '["linux_secure","who"]', JSON.stringify(r));
}

/* ============================ E. ranges ============================ */
{
    const d = (iso: string): number => secs(iso + 'T00:00:00Z');
    const r = dayRanges([d('2026-09-21'), d('2026-09-20'), d('2026-09-22'), d('2026-09-26'),
        d('2026-09-27'), d('2026-09-29'), d('2026-09-21')]);
    check('E1 consecutive days merge, gaps split, duplicates ignored, ascending',
        JSON.stringify(r) === JSON.stringify([
            { from: '2026-09-20', to: '2026-09-22' },
            { from: '2026-09-26', to: '2026-09-27' },
            { from: '2026-09-29', to: '2026-09-29' },
        ]), JSON.stringify(r));
    check('E2 no days, no ranges', dayRanges([]).length === 0, 'empty');
    const yr = dayRanges([d('2025-12-31'), d('2026-01-01')]);
    check('E3 a run crosses a year boundary',
        JSON.stringify(yr) === JSON.stringify([{ from: '2025-12-31', to: '2026-01-01' }]), JSON.stringify(yr));
}
{
    const mk = (iso: string): { dayTs: number; missing: number; hours: number; sourcetypes: string[] } => ({
        dayTs: secs(iso + 'T00:00:00Z'), missing: 1, hours: 1, sourcetypes: [],
    });
    const res = lateBackfillWindows([mk('2026-09-20'), mk('2026-09-21'), mk('2026-09-26'), mk('2026-09-30')], NOW);
    const ws = res.ok ? res.windows : [];
    check('F1 one window per run of days', res.ok && ws.length === 3, JSON.stringify(res));
    check('F2 each window is the whole UTC days of its run',
        ws.length === 3
        && ws[0].earliest === secs('2026-09-20T00:00:00Z') && ws[0].latest === secs('2026-09-22T00:00:00Z')
        && ws[1].earliest === secs('2026-09-26T00:00:00Z') && ws[1].latest === secs('2026-09-27T00:00:00Z'),
        JSON.stringify(ws));
    check('F3 the windows cover exactly the listed days',
        ws.reduce((s: number, w: { earliest: number; latest: number }) => s + (w.latest - w.earliest), 0) === 4 * D,
        JSON.stringify(ws));
    {
        const today = lateBackfillWindows([mk('2026-10-01')], NOW);
        check('F4 a range ending today stops at the current hour, never in the future',
            today.ok && today.windows[0].latest === secs('2026-10-01T02:00:00Z'), JSON.stringify(today));
    }
    const old = lateBackfillWindows([mk('2024-01-01'), mk('2026-09-26')], NOW);
    check('F5 a day older than the retention floor fails the whole set', !old.ok, JSON.stringify(old));
    check('F6 nothing to rebuild is an error, not an empty success', !lateBackfillWindows([], NOW).ok, 'empty');
}

/* ============================ G. text ============================ */
check('G1 thousands separators', fmtCount(206554) === '206,554' && fmtCount(15) === '15' && fmtCount(1000) === '1,000',
    `${fmtCount(206554)} ${fmtCount(15)} ${fmtCount(1000)}`);
{
    const day = { dayTs: secs('2026-09-26T00:00:00Z'), missing: 28193, hours: 42, sourcetypes: ['linux_secure', 'sap_logserv_logs'] };
    check('G2 a day line names the UTC date, the count, the hours and the sourcetypes',
        describeLateDay(day) === '2026-09-26: 28,193 events in 42 hours (linux_secure, sap_logserv_logs)',
        describeLateDay(day));
    const one = { dayTs: secs('2026-09-29T00:00:00Z'), missing: 1, hours: 1, sourcetypes: [] };
    check('G3 singulars and no sourcetypes', describeLateDay(one) === '2026-09-29: 1 event in 1 hour', describeLateDay(one));
    check('G4 the summary counts events and days',
        summarizeLate([day, one]) === '28,194 events on 2 days are in the index but not in the rollups.',
        summarizeLate([day, one]));
    check('G5 the summary singular', summarizeLate([one]) === '1 event on 1 day is in the index but not in the rollups.',
        summarizeLate([one]));
}

/* ===================================================================== */

if (laFailures > 0) {
    laProc.stderr.write(`\nlateArrivals.consistency-test: ${laFailures} failure(s) of ${laChecks}\n`);
    laProc.exit(1);
}
console.log(`lateArrivals.consistency-test: OK (${laChecks} checks)`);
