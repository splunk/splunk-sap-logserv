/**
 * Build-time consistency test for `hybridRouting.ts` (session 085).
 *
 * Asserts the sub-hour / wide-window read-source routing truth table: short
 * spans -> RAW (the rollup's hourly grain can't answer them), wide spans ->
 * CACHED, and every Splunk time-modifier form the picker can emit resolves
 * sensibly (unparseable / all-time -> CACHED, never a spurious raw scan).
 *
 * Run with: `npx ts-node --transpile-only hybridRouting.consistency-test.ts`
 *
 * Exits with code 1 on the first failure so CI can gate on it.
 */

/* eslint-disable no-console */

// This standalone script uses `require`, so add an explicit `export {}` at the
// end to mark it a MODULE — otherwise its top-level `const proc`/`failures`
// land in the global script scope and collide with the sibling
// jailbreakPatterns.consistency-test.ts (TS2451) during the project `tsc` pass.

// `require`/`process` are ambiently declared elsewhere in the project (see
// intentMap.consistency-test.ts) — don't redeclare (TS2451).
const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

interface RoutingModule {
    shouldUseRawSource: (earliest: string, latest: string) => boolean;
    HYBRID_RAW_MAX_SPAN_SEC: number;
}
const mod = require('./hybridRouting') as RoutingModule;

interface Case {
    earliest: string;
    latest: string;
    /** true = expect RAW, false = expect CACHED */
    raw: boolean;
    why: string;
}

// Threshold is 90 min. Cases straddle it and cover every picker form.
const CASES: Case[] = [
    // --- sub-hour presets / windows -> RAW ---
    { earliest: '-15m', latest: 'now', raw: true, why: 'Last 15 minutes' },
    { earliest: '-30m', latest: 'now', raw: true, why: 'Last 30 minutes' },
    { earliest: '-60m@m', latest: 'now', raw: true, why: 'Last 60 minutes (snap stripped)' },
    { earliest: '-1h', latest: 'now', raw: true, why: 'Last 1 hour == 3600s < 5400s' },
    // historical sub-hour custom window (both absolute) -> RAW (cache can't do
    // sub-hour even for past data)
    {
        earliest: '2026-07-01T14:10:00.000Z',
        latest: '2026-07-01T14:25:00.000Z',
        raw: true,
        why: 'custom historical 15-min window',
    },
    // real-time prefix stripped -> same as relative
    { earliest: 'rt-15m', latest: 'rt', raw: true, why: 'real-time last 15m' },

    // --- at/above threshold -> CACHED ---
    { earliest: '-90m', latest: 'now', raw: false, why: '90 min == threshold, not below' },
    { earliest: '-2h', latest: 'now', raw: false, why: 'Last 2 hours' },
    { earliest: '-4h', latest: 'now', raw: false, why: 'Last 4 hours' },
    { earliest: '-24h', latest: 'now', raw: false, why: 'Last 24 hours' },
    { earliest: '-7d', latest: 'now', raw: false, why: 'Last 7 days' },
    { earliest: '-30d@d', latest: 'now', raw: false, why: 'default range' },
    { earliest: '-90d', latest: 'now', raw: false, why: 'Last 90 days' },

    // --- wide window ending at now must NOT route to raw (span-only rule; the
    //     leading-edge lag is accepted, not closed with a full raw scan) ---
    { earliest: '-30d@d', latest: '-1d@d', raw: false, why: 'wide, not ending now' },

    // --- degenerate / all-time / unparseable -> CACHED (no regression) ---
    { earliest: '0', latest: 'now', raw: false, why: 'all time' },
    { earliest: '', latest: 'now', raw: false, why: 'empty earliest -> all time' },
    { earliest: 'garbage', latest: 'now', raw: false, why: 'unparseable -> cached' },
];

let failures = 0;
for (const c of CASES) {
    const got = mod.shouldUseRawSource(c.earliest, c.latest);
    const want = c.raw;
    if (got !== want) {
        failures += 1;
        proc.stderr.write(
            `FAIL: shouldUseRawSource("${c.earliest}","${c.latest}") = ${got}, ` +
                `want ${want} (${c.why})\n`,
        );
    }
}

if (mod.HYBRID_RAW_MAX_SPAN_SEC !== 90 * 60) {
    failures += 1;
    proc.stderr.write(
        `FAIL: HYBRID_RAW_MAX_SPAN_SEC = ${mod.HYBRID_RAW_MAX_SPAN_SEC}, want ${90 * 60}\n`,
    );
}

if (failures > 0) {
    proc.stderr.write(`\nhybridRouting consistency test: ${failures} failure(s)\n`);
    proc.exit(1);
}
console.log(`hybridRouting consistency test: ${CASES.length} cases OK`);

export {};
