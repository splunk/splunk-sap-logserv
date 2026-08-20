/**
 * The raw-twin channel (design §17.1, corrected by §17.8a-15/16).
 *
 * Every hybrid panel owns two arms: a cached (rollup) query and a byte-equal
 * raw query (sessions 085–087). The router dispatches one of them; the OTHER
 * arm — the raw one, when the cached arm was dispatched — is exactly the
 * evidence check 21 (cached-vs-raw reconciliation) needs. This module is the
 * side-channel that carries it from the routing point to the diagnostic
 * drawer without threading a prop through every chart component.
 *
 * - `recordRawTwin(cached, raw)` is called wherever both arms are in scope:
 *   `useRoutedQuery` (the common path) and the six span-parametrised memos
 *   that route inline via `shouldUseRawSource` (§17.8a-17; WebDispatcher,
 *   DataPipelineOverview, DnsAnalytics — two each).
 * - `rawTwinFor(spl)` resolves the twin AT DRAWER-REQUEST BUILD TIME
 *   (EmptyStateHint), NOT via the collector registration record — the sweep
 *   never runs deep probes, so a registry copy would be dead weight and its
 *   dep-array staleness a bug factory (§17.8a-15).
 *
 * Deliberately React-free and dependency-free: the build gate's TS loader
 * follows relative imports as `.ts` only, so anything reachable from a
 * consistency test must not pull in a `.tsx` (§17.8a-16, §12.11).
 *
 * The map is keyed by the EXACT cached SPL string as dispatched — the cloud
 * splice (`mapCloudProviderQueries`/`withCloudProvider`) is applied to BOTH
 * arms BEFORE routing in every dashboard (verified session 102), so the
 * dispatched string equals the recorded key. When the router chose the RAW
 * arm (sub-90-minute window), `rawTwinFor(raw)` misses and the caller gets
 * null — correct: the panel already ran the raw query.
 *
 * Bounded: cap 400 entries, EVICT-OLDEST on overflow (never clear-all — a
 * clear would leave every mounted panel twin-less until its next render;
 * §17.8a-16). Map iteration order is insertion order, so the first key is
 * the oldest.
 */

const MAX_TWINS = 400;

const twins = new Map<string, string>();

/** Record that `cached` has the byte-equal raw arm `raw`. */
export const recordRawTwin = (cached: string, raw: string): void => {
    if (!cached || !raw || cached === raw) return;
    // Re-inserting moves the key to the newest position (delete-then-set), so
    // actively rendered panels can never be the ones evicted.
    if (twins.has(cached)) twins.delete(cached);
    twins.set(cached, raw);
    if (twins.size > MAX_TWINS) {
        const oldest = twins.keys().next().value;
        if (oldest !== undefined) twins.delete(oldest);
    }
};

/** The raw arm recorded for this exact dispatched SPL, or null. */
export const rawTwinFor = (spl: string): string | null => twins.get(spl) ?? null;

/** Test-only: current size (the consistency test asserts the eviction cap). */
export const rawTwinCount = (): number => twins.size;

/** Test-only: reset between test cases. */
export const clearRawTwins = (): void => twins.clear();
