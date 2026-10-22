/**
 * Build-time consistency test for `timechartSpan.ts` (build 377).
 *
 * The module decides what span every range-following chart dispatches and,
 * since build 377, what each chart prints as its span and what a KPI
 * sparkline's tooltip says about its bucket. The cases pin:
 *
 *   - chooseTimechartSpan at the four presets and the 6-hour boundary;
 *   - applySpanToken's rollup clamp (`bucket_ts` reads never bin under 1h;
 *     tstats and raw reads do), and that a token-free query is returned as is;
 *   - timechartSpanOf / spanSubtitle: the label is the span of the LAST
 *     timechart of the DISPATCHED query, so a rollup chart at Last 24 hours
 *     says "span 1h", never the picked 15m;
 *   - formatBucketTime: the tooltip prints the wall clock Splunk wrote into
 *     `_time` (the Splunk user's zone), whatever zone the browser runs in;
 *   - utcDayLabel: a beaconing point (a UTC-day rollup row) is labelled with
 *     the UTC date it carries, and a zero-filled bin with the one UTC day its
 *     local-day bin holds - checked for every 15-minute offset from -12h to
 *     +14h over a year of days; a zero-filled bin whose UTC day has not ended
 *     (the in-progress day, and west of UTC the trailing bin's next day) is
 *     labelled "not yet computed", to the second, never a carried day.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
    env: Record<string, string | undefined>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./timechartSpan') as any;
const SPAN_TOKEN = mod.SPAN_TOKEN as string;
const chooseTimechartSpan = mod.chooseTimechartSpan as (e: string, l: string) => string;
const applySpanToken = mod.applySpanToken as (spl: string, span: string) => string;
const applySpanTokens = mod.applySpanTokens as <T extends Record<string, string>>(q: T, span: string) => T;
const timechartSpanOf = mod.timechartSpanOf as (spl: string) => string | null;
const spanSubtitle = mod.spanSubtitle as (lead: string, spl: string, tail?: string) => string;
const formatBucketTime = mod.formatBucketTime as (raw: unknown) => string | null;
const utcDayLabel = mod.utcDayLabel as (dayTs: unknown, binStart?: unknown, nowSec?: number) => string | null;
const UTC_DAY_SUFFIX = mod.UTC_DAY_SUFFIX as string;
const UTC_DAY_PENDING_SUFFIX = mod.UTC_DAY_PENDING_SUFFIX as string;

let failures = 0;
let checks = 0;
const fail = (m: string): void => {
    failures += 1;
    proc.stderr.write(`FAIL: ${m}\n`);
};
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) fail(`${label}: ${detail}`);
};
const eq = (label: string, got: unknown, want: unknown): void =>
    check(label, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// --- chooseTimechartSpan -----------------------------------------------------
eq('span Last 24 hours', chooseTimechartSpan('-24h@h', 'now'), '15m');
eq('span Last 7 days', chooseTimechartSpan('-7d@h', 'now'), '1h');
eq('span Last 30 days', chooseTimechartSpan('-30d@d', 'now'), '6h');
eq('span Last 90 days', chooseTimechartSpan('-90d@d', 'now'), '1d');
eq('span custom 4 hours', chooseTimechartSpan('-4h', 'now'), '1m');
eq('span exactly 6 hours', chooseTimechartSpan('-6h', 'now'), '1m');
eq('span 6 hours + 1 s', chooseTimechartSpan('-21601s', 'now'), '15m');
eq('span 60 minutes', chooseTimechartSpan('-60m', 'now'), '1m');

// --- applySpanToken / applySpanTokens -----------------------------------------
const ROLLUP_Q = `| inputlookup logserv_severity_rollup where metric="trend" | addinfo | where bucket_ts>=info_min_time AND bucket_ts<info_max_time | eval _time=bucket_ts | timechart span=${SPAN_TOKEN} sum(count) by trend_src`;
const TSTATS_Q = `| tstats count WHERE \`sap_logserv_idx_macro\` BY _time span=${SPAN_TOKEN} | timechart span=${SPAN_TOKEN} sum(count) as "Events"`;
const RAW_Q = `\`sap_logserv_idx_macro\` sourcetype="squid:access" | timechart span=${SPAN_TOKEN} count`;
eq('clamp: rollup at 15m', timechartSpanOf(applySpanToken(ROLLUP_Q, '15m')), '1h');
eq('clamp: rollup at 1m', timechartSpanOf(applySpanToken(ROLLUP_Q, '1m')), '1h');
eq('clamp: rollup at 1h', timechartSpanOf(applySpanToken(ROLLUP_Q, '1h')), '1h');
eq('clamp: rollup at 6h', timechartSpanOf(applySpanToken(ROLLUP_Q, '6h')), '6h');
eq('clamp: rollup at 1d', timechartSpanOf(applySpanToken(ROLLUP_Q, '1d')), '1d');
eq('no clamp: tstats at 15m', applySpanToken(TSTATS_Q, '15m'),
    '| tstats count WHERE `sap_logserv_idx_macro` BY _time span=15m | timechart span=15m sum(count) as "Events"');
eq('no clamp: raw at 1m', timechartSpanOf(applySpanToken(RAW_Q, '1m')), '1m');
check('every token replaced', applySpanToken(ROLLUP_Q, '6h').indexOf(SPAN_TOKEN) === -1,
    'a token survived the substitution');
{
    const plain = '| inputlookup x | eval _time=bucket_ts | timechart span=1d sum(count) as count';
    eq('token-free query unchanged', applySpanToken(plain, '15m'), plain);
    const qs = { a: plain, b: 'search foo | stats count' };
    check('applySpanTokens keeps a token-free map', applySpanTokens(qs, '15m') === qs,
        'expected the SAME object back when nothing carries the token');
    const qs2 = { a: plain, b: ROLLUP_Q, c: TSTATS_Q };
    const out = applySpanTokens(qs2, '15m');
    check('applySpanTokens returns a new map', out !== qs2, 'expected a new object when a value carries the token');
    eq('applySpanTokens leaves token-free values', out.a, plain);
    eq('applySpanTokens clamps the rollup value', timechartSpanOf(out.b), '1h');
    eq('applySpanTokens keeps the tstats value fine', timechartSpanOf(out.c), '15m');
}

// --- timechartSpanOf -----------------------------------------------------------
eq('tstats pre-bin then timechart', timechartSpanOf('| tstats count where index=x by _time span=5m | timechart span=6h sum(count)'), '6h');
eq('two timecharts: the last', timechartSpanOf('search a | timechart span=1h count | timechart span=1d sum(count)'), '1d');
eq('unsubstituted token', timechartSpanOf(ROLLUP_Q), null);
eq('no timechart', timechartSpanOf('| inputlookup x | stats sum(count) as count'), null);
eq('bin span is not a timechart span', timechartSpanOf('search a | bin _time span=1h | timechart count'), null);
eq('mon unit', timechartSpanOf('search a | timechart span=1mon count'), '1mon');
eq('week unit', timechartSpanOf('search a | timechart span=2w count'), '2w');
eq('span after other options', timechartSpanOf('search a | timechart limit=0 useother=f span=15m count by b'), '15m');
eq('spaces around =', timechartSpanOf('search a | timechart span = 1h count'), '1h');
eq('span of a later pipe is not this timechart', timechartSpanOf('search a | timechart count | bin _time span=1h'), null);
eq('a sparkline query', timechartSpanOf('| inputlookup x | eval _time=bucket_ts | timechart span=1d sum(count) as count | fillnull value=0'), '1d');

// --- spanSubtitle ------------------------------------------------------------------
eq('subtitle with span', spanSubtitle('Proxy request count', 'x | timechart span=6h count'), 'Proxy request count — span 6h');
eq('subtitle with span and tail', spanSubtitle('dp_severity breakdown', 'x | timechart span=1h count', 'click to open Work Process Performance'),
    'dp_severity breakdown — span 1h — click to open Work Process Performance');
eq('subtitle without a readable span', spanSubtitle('Lead', 'x | stats count'), 'Lead');
eq('subtitle without span, with tail', spanSubtitle('Lead', 'x | stats count', 'tail'), 'Lead — tail');
eq('subtitle with an empty tail', spanSubtitle('Lead', 'x | timechart span=1d count', ''), 'Lead — span 1d');
// The point of reading the DISPATCHED query: at Last 24 hours the picked span
// is 15m, and a rollup chart draws 1h.
{
    const picked = chooseTimechartSpan('-24h@h', 'now');
    eq('Last 24h rollup chart label', spanSubtitle('Error count', applySpanToken(ROLLUP_Q, picked)), 'Error count — span 1h');
    eq('Last 24h tstats chart label', spanSubtitle('Request count', applySpanToken(TSTATS_Q, picked)), 'Request count — span 15m');
}

// --- formatBucketTime: the Splunk user's zone, whatever the browser's ---------
const ZONES = ['UTC', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Auckland'];
// This suite shares its process with every other suite check-diagnostics runs,
// so the runtime zone must come back exactly. Node re-reads its zone when TZ is
// SET, not when it is deleted: the original zone is put back by name first.
const savedTz = proc.env.TZ;
const zoneOf = (): string | undefined => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
};
const savedZone = zoneOf();
const savedOffsets = [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)].map((t) => new Date(t).getTimezoneOffset());
try {
    ZONES.forEach((tz) => {
        proc.env.TZ = tz;
        const z = ` (runtime TZ=${tz})`;
        eq(`Central local midnight${z}`, formatBucketTime('2026-10-07T00:00:00.000-05:00'), 'Oct 7, 2026, 12:00 AM');
        eq(`Central evening${z}`, formatBucketTime('2026-10-06T19:00:00.000-05:00'), 'Oct 6, 2026, 7:00 PM');
        eq(`India half-hour offset${z}`, formatBucketTime('2026-10-07T13:05:00.000+05:30'), 'Oct 7, 2026, 1:05 PM');
        eq(`UTC Z${z}`, formatBucketTime('2026-10-07T00:00:00Z'), 'Oct 7, 2026, 12:00 AM');
        eq(`compact offset${z}`, formatBucketTime('2026-10-07T12:30:00.000+0200'), 'Oct 7, 2026, 12:30 PM');
        eq(`no offset${z}`, formatBucketTime('2026-10-07 23:59:59'), 'Oct 7, 2026, 11:59 PM');
        eq(`noon${z}`, formatBucketTime('2026-01-31T12:00:00.000-06:00'), 'Jan 31, 2026, 12:00 PM');
        eq(`epoch seconds print UTC${z}`, formatBucketTime(Date.UTC(2026, 9, 7) / 1000), 'Oct 7, 2026, 12:00 AM UTC');
    });
} finally {
    proc.env.TZ = savedTz ?? savedZone ?? 'UTC';
    if (typeof savedTz === 'undefined') delete proc.env.TZ;
}
check('runtime zone restored', zoneOf() === savedZone && proc.env.TZ === savedTz,
    `the suite must leave the process zone as it found it (${String(savedZone)}, TZ=${String(savedTz)}), got ${String(zoneOf())}, TZ=${String(proc.env.TZ)}`);
check('runtime offsets restored',
    [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)].map((t) => new Date(t).getTimezoneOffset()).join() === savedOffsets.join(),
    'later suites would run in another zone');
eq('not an ISO time', formatBucketTime('garbage'), 'garbage');
eq('impossible date', formatBucketTime('2026-02-30T00:00:00Z'), '2026-02-30T00:00:00Z');
eq('bad offset', formatBucketTime('2026-10-07T00:00:00+25:00'), '2026-10-07T00:00:00+25:00');
eq('null', formatBucketTime(null), null);
eq('undefined', formatBucketTime(undefined), null);
eq('empty string', formatBucketTime(''), null);
eq('NaN', formatBucketTime(NaN), null);

// --- utcDayLabel: a UTC-day point keeps its UTC date ----------------------------
const OCT7 = Date.UTC(2026, 9, 7) / 1000;
// A clock long after every day the cases below derive, so each is complete.
const SETTLED = Date.UTC(2030, 0, 1) / 1000;
eq('carried day_ts string', utcDayLabel(String(OCT7), '2026-10-06T00:00:00.000-05:00'), `Oct 7, 2026${UTC_DAY_SUFFIX}`);
eq('carried day_ts number', utcDayLabel(OCT7), 'Oct 7, 2026 (UTC day)');
eq('carried value inside the day', utcDayLabel(OCT7 + 3600), 'Oct 7, 2026 (UTC day)');
eq('carried ISO with offset', utcDayLabel('2026-10-06T19:00:00.000-05:00'), 'Oct 7, 2026 (UTC day)');
// The defect: Splunk bins 00:00 UTC Oct 7 into the Central-time day Oct 6, and
// the old tooltip printed that bin's local date.
eq('Central bin, nothing carried', utcDayLabel(null, '2026-10-06T00:00:00.000-05:00', SETTLED), 'Oct 7, 2026 (UTC day)');
check('Central bin: the local date differs', formatBucketTime('2026-10-06T00:00:00.000-05:00') === 'Oct 6, 2026, 12:00 AM',
    'the bin start must still read as the local date it is');
eq('zero carried (fillnull) falls back to the bin', utcDayLabel('0', '2026-10-06T00:00:00.000-05:00', SETTLED), 'Oct 7, 2026 (UTC day)');
eq('empty carried falls back to the bin', utcDayLabel('', '2026-10-06T00:00:00.000-05:00', SETTLED), 'Oct 7, 2026 (UTC day)');
eq('India bin', utcDayLabel(undefined, '2026-10-07T00:00:00.000+05:30', SETTLED), 'Oct 7, 2026 (UTC day)');
eq('UTC bin', utcDayLabel(undefined, '2026-10-07T00:00:00.000+00:00', SETTLED), 'Oct 7, 2026 (UTC day)');
eq('UTC-12 bin', utcDayLabel(undefined, '2026-10-07T00:00:00.000-12:00', SETTLED), 'Oct 8, 2026 (UTC day)');
eq('UTC+14 bin', utcDayLabel(undefined, '2026-10-07T00:00:00.000+14:00', SETTLED), 'Oct 7, 2026 (UTC day)');
eq('epoch bin start', utcDayLabel(null, OCT7 - 5 * 3600, SETTLED), 'Oct 7, 2026 (UTC day)');
eq('bin without an offset', utcDayLabel(null, '2026-10-07T00:00:00', SETTLED), null);
eq('nothing at all', utcDayLabel(null, null, SETTLED), null);
eq('garbage', utcDayLabel('x', 'y', SETTLED), null);

// --- utcDayLabel: a zero-filled day that has not ended is not a measurement ------
// The beaconing aggregates write complete UTC days only, and the DNS / Network
// Perimeter sparklines 0-fill every local-day bin of the search range. At 10:00
// Central on Oct 9 (15:00 UTC) the last two Central bins hold the UTC midnights
// of Oct 9 (in progress) and Oct 10 (not begun); both read "not yet computed".
{
    const NOW = Date.UTC(2026, 9, 9, 15) / 1000;
    const PENDING = (d: string): string => `${d}${UTC_DAY_PENDING_SUFFIX}`;
    eq('pending suffix', UTC_DAY_PENDING_SUFFIX, ' (UTC day, not yet computed)');
    eq('Central, the in-progress UTC day', utcDayLabel('', '2026-10-08T00:00:00.000-05:00', NOW), PENDING('Oct 9, 2026'));
    eq('Central, the trailing bin: a UTC day not begun', utcDayLabel('', '2026-10-09T00:00:00.000-05:00', NOW), 'Oct 10, 2026 (UTC day, not yet computed)');
    eq('Central, the last complete UTC day', utcDayLabel('', '2026-10-07T00:00:00.000-05:00', NOW), 'Oct 8, 2026 (UTC day)');
    eq('India, the in-progress UTC day', utcDayLabel(null, '2026-10-09T00:00:00.000+05:30', NOW), PENDING('Oct 9, 2026'));
    eq('UTC, the in-progress UTC day', utcDayLabel(null, '2026-10-09T00:00:00.000+00:00', NOW), PENDING('Oct 9, 2026'));
    eq('UTC, yesterday', utcDayLabel(null, '2026-10-08T00:00:00.000+00:00', NOW), 'Oct 8, 2026 (UTC day)');
    eq('epoch bin, in progress', utcDayLabel(null, Date.UTC(2026, 9, 8, 5) / 1000, NOW), PENDING('Oct 9, 2026'));
    // A carried day is a row the rollup holds: never pending, whatever the clock.
    eq('carried day, clock inside it', utcDayLabel(Date.UTC(2026, 9, 9) / 1000, '2026-10-08T00:00:00.000-05:00', NOW), 'Oct 9, 2026 (UTC day)');
    eq('carried day, clock before it', utcDayLabel(Date.UTC(2026, 9, 9) / 1000, undefined, Date.UTC(2026, 0, 1) / 1000), 'Oct 9, 2026 (UTC day)');
    // The boundary, to the second: a day is complete when its end is not after now.
    const OCT9 = Date.UTC(2026, 9, 9) / 1000;
    eq('one second before the day ends', utcDayLabel(null, '2026-10-09T00:00:00.000+00:00', OCT9 + 86400 - 1), PENDING('Oct 9, 2026'));
    eq('the second the day ends', utcDayLabel(null, '2026-10-09T00:00:00.000+00:00', OCT9 + 86400), 'Oct 9, 2026 (UTC day)');
    eq('a clock at the day start', utcDayLabel(null, '2026-10-09T00:00:00.000+00:00', OCT9), PENDING('Oct 9, 2026'));
    // Left out, the clock is the real one: a far-future bin is pending, an old one is not.
    eq('real clock, far future', utcDayLabel(null, '2099-01-01T00:00:00.000+00:00'), PENDING('Jan 1, 2099'));
    eq('real clock, the past', utcDayLabel(null, '2020-01-01T00:00:00.000+00:00'), 'Jan 1, 2020 (UTC day)');
}

// Property: in every fixed-offset zone from -12h to +14h (15-minute steps), the
// local-day bin that holds a UTC day D starts at L with L <= D < L + 1 day, and
// Splunk writes L as the wall clock at that offset. Derived from L alone, the
// label must be D's, for a year of days (leap day and year end included).
{
    const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0');
    const isoAt = (epoch: number, off: number): string => {
        const w = new Date((epoch + off) * 1000);
        const sign = off < 0 ? '-' : '+';
        const a = Math.abs(off);
        return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:00.000${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
    };
    const start = Date.UTC(2027, 11, 1) / 1000 - 400 * 86400; // spans 2026-12-31 and 2027-12-31
    let bad = 0;
    let firstBad = '';
    let n = 0;
    for (let off = -12 * 3600; off <= 14 * 3600; off += 900) {
        for (let i = 0; i < 400; i += 1) {
            const D = start + i * 86400;
            const L = Math.floor((D + off) / 86400) * 86400 - off;
            const want = utcDayLabel(D);
            const got = utcDayLabel(null, isoAt(L, off), SETTLED);
            // The same bin while its UTC day runs (its last second) and once it
            // has ended (its end, exactly).
            const open = utcDayLabel(null, isoAt(L, off), D + 86400 - 1);
            const closed = utcDayLabel(null, isoAt(L, off), D + 86400);
            const wantOpen = typeof want === 'string' ? want.replace(UTC_DAY_SUFFIX, UTC_DAY_PENDING_SUFFIX) : want;
            n += 1;
            if (got !== want || closed !== want || open !== wantOpen) {
                bad += 1;
                if (!firstBad) firstBad = `offset ${off}s day ${D}: bin ${isoAt(L, off)} -> ${got} / ${open} / ${closed}, carried -> ${want}`;
            }
        }
    }
    check(`bin-derived UTC day equals the carried day (${n} bins)`, bad === 0, `${bad} mismatches; first: ${firstBad}`);
}

if (failures > 0) {
    proc.stderr.write(`timechartSpan consistency test: ${failures} FAILURE(S) in ${checks} checks\n`);
    proc.exit(1);
}
console.log(`timechartSpan consistency test: ${checks} checks OK`);
