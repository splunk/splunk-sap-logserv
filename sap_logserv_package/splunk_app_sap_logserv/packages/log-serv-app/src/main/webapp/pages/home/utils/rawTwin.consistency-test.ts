/**
 * Build-time consistency test for `rawTwin.ts` (design §17.1 / §17.8a-16).
 *
 * Pins: record/lookup round-trip; a raw-arm dispatch (rawTwinFor(raw)) MISSES
 * (correct — the panel already ran the raw query); the 400-entry cap
 * EVICTS-OLDEST (never clears), so an actively-rendered twin survives a flood;
 * re-recording refreshes eviction order; empty/degenerate inputs are ignored.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./rawTwin') as any;
const recordRawTwin = mod.recordRawTwin as (c: string, r: string) => void;
const rawTwinFor = mod.rawTwinFor as (s: string) => string | null;
const rawTwinCount = mod.rawTwinCount as () => number;
const clearRawTwins = mod.clearRawTwins as () => void;

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) {
        failures += 1;
        proc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};

clearRawTwins();

// 1. Basic round-trip.
recordRawTwin('CACHED_A', 'RAW_A');
check('round-trip', rawTwinFor('CACHED_A') === 'RAW_A', `got ${rawTwinFor('CACHED_A')}`);

// 2. A raw-arm lookup misses (the router chose the raw arm; nothing to add).
check('raw-arm lookup misses', rawTwinFor('RAW_A') === null, `got ${rawTwinFor('RAW_A')}`);

// 3. Unknown key → null.
check('unknown key → null', rawTwinFor('NOPE') === null, `got ${rawTwinFor('NOPE')}`);

// 4. Degenerate inputs ignored (empty / identical arms).
const before = rawTwinCount();
recordRawTwin('', 'x');
recordRawTwin('y', '');
recordRawTwin('same', 'same');
check('degenerate inputs ignored', rawTwinCount() === before, `count moved ${before}→${rawTwinCount()}`);

// 5. Eviction cap: flood past 400 and confirm the OLDEST is evicted, not a clear.
clearRawTwins();
recordRawTwin('KEEP_ME', 'RAW_KEEP'); // the oldest — but re-touch it so it survives
for (let i = 0; i < 450; i += 1) recordRawTwin(`C_${i}`, `R_${i}`);
check('cap holds at ≤400', rawTwinCount() <= 400, `count=${rawTwinCount()}`);
check('oldest evicted, not cleared (KEEP_ME gone)', rawTwinFor('KEEP_ME') === null, 'KEEP_ME survived');
check('recent entries retained', rawTwinFor('C_449') === 'R_449', `got ${rawTwinFor('C_449')}`);
check('map not wiped', rawTwinCount() > 300, `count=${rawTwinCount()}`);

// 6. Re-recording refreshes eviction order (an actively-rendered twin survives).
clearRawTwins();
recordRawTwin('OLD', 'R_OLD');
for (let i = 0; i < 399; i += 1) recordRawTwin(`F_${i}`, `RF_${i}`); // now 400 total
recordRawTwin('OLD', 'R_OLD'); // re-touch → moves OLD to newest
recordRawTwin('NEWEST', 'R_NEWEST'); // overflow → evicts the true-oldest (F_0), not OLD
check('re-touched key survives overflow', rawTwinFor('OLD') === 'R_OLD', `got ${rawTwinFor('OLD')}`);
check('the untouched oldest was evicted', rawTwinFor('F_0') === null, 'F_0 survived');

clearRawTwins();

if (failures > 0) {
    proc.stderr.write(`rawTwin consistency test: ${failures} FAILURE(S) in ${checks} checks\n`);
    proc.exit(1);
}
console.log(`rawTwin consistency test: ${checks} checks OK`);
