import { serverClockSec } from './backfillPlan';

/**
 * The search head's clock, for working out where a time range starts (build 397).
 *
 * Splunk resolves `-7d@h` against the server's clock. A bound worked out from a browser
 * clock that runs days fast would start late and lose rows without a sign, so the
 * browser's clock is never trusted alone: one cheap read at start-up gives the difference,
 * from the Date header of a response (utils/backfillPlan.ts serverClockSec), and now is
 * the earlier of the two clocks. Until that read has answered, or if it cannot, there is
 * no now, and a reader goes without its bound: slower, never wrong. A panel under a filter
 * waits for this read, so it has a time limit.
 */

const PROBE = '/en-US/splunkd/__raw/services/server/info?output_mode=json';

/** A read that takes longer than this counts as no answer. */
export const SERVER_CLOCK_TIMEOUT_MS = 5000;

let offsetSec: number | null = null;
let started = false;
let settled = false;
const waiting: (() => void)[] = [];

const settle = (): void => {
    if (settled) return;
    settled = true;
    waiting.splice(0).forEach((f) => f());
};

/** Starts the read, once. Safe to call from anywhere. */
export const startServerClock = (
    fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): void => {
    if (started) return;
    started = true;
    const aborter = new AbortController();
    // Settles by itself too: a read that ignores its signal must not hold the panels.
    const timer = window.setTimeout(() => {
        settle();
        aborter.abort();
    }, SERVER_CLOCK_TIMEOUT_MS);
    fetchImpl(PROBE, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: aborter.signal })
        .then((res) => {
            window.clearTimeout(timer);
            const server = res.ok ? serverClockSec(res.headers.get('Date')) : null;
            if (server !== null) offsetSec = server - Date.now() / 1000;
            settle();
        })
        .catch(() => {
            window.clearTimeout(timer);
            settle();
        });
};

/** True once the read has answered or failed: there will be no better answer. */
export const serverClockSettled = (): boolean => settled;

/** Calls back once settled, at once if it already is. */
export const onServerClockSettled = (f: () => void): void => {
    if (settled) f();
    else waiting.push(f);
};

/** Now in epoch seconds, on the earlier clock; null while the server's clock is unknown. */
export const serverNowSec = (): number | null => {
    startServerClock();
    if (offsetSec === null) return null;
    const browser = Date.now() / 1000;
    return Math.min(browser, browser + offsetSec);
};
