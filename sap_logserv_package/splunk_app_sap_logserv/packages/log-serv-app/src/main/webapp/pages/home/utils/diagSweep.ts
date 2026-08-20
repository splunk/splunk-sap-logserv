/**
 * diagSweep — diagnose every search on the current dashboard (session 095,
 * design §6 entry point 3: Actions -> "Diagnose this dashboard").
 *
 * THE MEMOIZING RUNNER IS THE POINT. A dashboard with 20 empty panels must
 * not cost 20× the probes: the canary, the index-presence count, the
 * visibility list and the macro read are identical for every panel on the
 * page, and the sourcetype/collection probes repeat across panels that read
 * the same data. `createMemoizingRunner` wraps the real (budgeted, singleton)
 * runner and dedupes at PROMISE level — concurrent identical probes share one
 * dispatch — so `gatherPanelEvidence` runs completely unchanged per panel
 * while the marginal panel costs only its own novel probes. The sweep itself
 * is SEQUENTIAL (design Risk 5: the machine being diagnosed may already be
 * saturated; the per-runner concurrency cap stays the only parallelism).
 *
 * A SKIPPED result is cached like any other: once the budget is spent, every
 * remaining panel's probes resolve as skipped instantly, and the report says
 * so rather than silently thinning out.
 *
 * `RegistrationLike` restates the collector's registration shape structurally
 * rather than importing it: the registry lives in a `.tsx` (it is a React
 * provider), and everything reachable from the build gate must resolve as
 * `.ts` only.
 */

import { ProbeRunner, ProbeResult } from './diagProbe';
import {
    gatherPanelEvidence,
    PanelEvidence,
    collectProducerSpl,
    ProducerSplEntry,
} from './diagEvidence';
import { diagnosePanel, Diagnosis } from './diagCascade';
import { explainEmptyPanel, PanelFacts, Verdict } from './panelDiagnosis';
import { probeSpl, SplProbe } from './splProbe';

/** A short human descriptor for a search, derived from its classification —
 *  registrations carry no panel title (`useSearch` does not know it), so this
 *  is how a report row names a panel. Lives here, not in `diagReport`, so the
 *  report module can stay a pure downstream consumer (no value cycle). */
export const describeSearch = (probe: SplProbe, spl: string): string => {
    if (probe.tier === 'cached' && probe.collection) {
        return probe.metric
            ? `Summarised read: ${probe.collection} (${probe.metric})`
            : `Summarised read: ${probe.collection}`;
    }
    if (probe.sourcetypes.length > 0) {
        const head = probe.sourcetypes.slice(0, 3).join(', ');
        return `${probe.tier === 'tstats' ? 'Indexed count' : 'Event search'}: ${head}${
            probe.sourcetypes.length > 3 ? ', …' : ''
        }`;
    }
    if (probe.tags.length > 0) return `Tag-scoped search: tag=${probe.tags.join(', tag=')}`;
    const flat = spl.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat || '(empty query)';
};

/** Structural copy of `state/DiagnosticCollector`'s SearchRegistration. */
export interface RegistrationLike {
    id: string;
    spl: string;
    earliest: string;
    latest: string;
    dispatched: boolean;
    loading: boolean;
    errorMessage: string | null;
    rowCount: number | null;
}

export type PanelClassification =
    | 'ok'
    | 'empty'
    | 'error'
    | 'loading'
    | 'not-dispatched'
    | 'no-query';

export interface SweepEntry {
    index: number;
    descriptor: string;
    spl: string;
    earliest: string;
    latest: string;
    rowCount: number | null;
    errorMessage: string | null;
    classification: PanelClassification;
    /** The free-check verdict (never a fault without local evidence). */
    freeVerdict: Verdict | null;
    /** Present only for deep-diagnosed (empty) panels. */
    diag?: Diagnosis;
    evidence?: PanelEvidence;
}

export interface SweepResult {
    entries: SweepEntry[];
    diagnosedCount: number;
    budgetExhausted: boolean;
}

export const classifyRegistration = (reg: RegistrationLike): PanelClassification => {
    if (!reg.spl) return 'no-query';
    if (!reg.dispatched) return 'not-dispatched';
    if (reg.loading) return 'loading';
    if (reg.errorMessage) return 'error';
    if (reg.rowCount === 0) return 'empty';
    return 'ok';
};

/**
 * Wrap a runner so identical probes dispatch once. Promise-level: the FIRST
 * caller's promise is stored before it resolves, so concurrent duplicates
 * (the runner allows 2 in flight) also share. Cache keys use U+0000 as the
 * separator — it cannot appear in SPL or URLs.
 */
export const createMemoizingRunner = (inner: ProbeRunner): ProbeRunner => {
    const searchCache = new Map<string, Promise<ProbeResult<unknown>>>();
    const kvCache = new Map<string, Promise<ProbeResult<unknown>>>();
    const restCache = new Map<string, Promise<ProbeResult<unknown>>>();

    const kvKey = (collection: string, params: Record<string, string>): string =>
        collection +
        '\u0000' +
        Object.keys(params)
            .sort()
            .map((k) => `${k}=${params[k]}`)
            .join('&');

    return {
        search<TRow>(
            spl: string,
            earliest: string,
            latest: string,
            maxTimeSeconds?: number,
        ): Promise<ProbeResult<TRow>> {
            /* §19.8a-4 rider (H19, pre-existing latent): the 4th argument was
             * silently DROPPED here, so a deep probe's per-probe runtime cap
             * never reached the server through this wrapper. Forwarded AND
             * part of the memo key — two calls differing only in their cap
             * must not share a dispatch. */
            const key = `${spl}\u0000${earliest}\u0000${latest}\u0000${maxTimeSeconds ?? ''}`;
            if (!searchCache.has(key)) {
                searchCache.set(key, inner.search(spl, earliest, latest, maxTimeSeconds));
            }
            return searchCache.get(key) as Promise<ProbeResult<TRow>>;
        },
        kv<TRow>(collection: string, params: Record<string, string>): Promise<ProbeResult<TRow>> {
            const key = kvKey(collection, params);
            if (!kvCache.has(key)) {
                kvCache.set(key, inner.kv(collection, params));
            }
            return kvCache.get(key) as Promise<ProbeResult<TRow>>;
        },
        rest<TRow>(url: string): Promise<ProbeResult<TRow>> {
            if (!restCache.has(url)) {
                restCache.set(url, inner.rest(url));
            }
            return restCache.get(url) as Promise<ProbeResult<TRow>>;
        },
        cancel: (): void => inner.cancel(),
        isCancelled: (): boolean => inner.isCancelled(),
        elapsedMs: (): number => inner.elapsedMs(),
        remainingMs: (): number => inner.remainingMs(),
        dispatched: (): number => inner.dispatched(),
    };
};

/**
 * §20.3 — the WHOLE dashboard's rollup-populating saved searches, for the
 * dashboard report's deduplicated section. Enumerates every registration's
 * collections (a memoised regex parse — no dispatch) and fetches each
 * registered aggregate's SPL once. Deliberately NOT on `SweepResult`:
 * `buildDashboardReportModel` serialises the sweep wholesale into
 * `json.sweep`, and the SPL must appear exactly twice in a stored model
 * (§20.8a-5) — the caller passes this as `DashboardReportInput.rollupSearches`
 * instead. Returns null (section absent) when the runner is already
 * cancelled/out of budget, or nothing on the dashboard reads a rollup.
 */
export const collectDashboardRollupSpl = async (
    runner: ProbeRunner,
    regs: RegistrationLike[],
): Promise<ProducerSplEntry[] | null> => {
    const collections: string[] = [];
    regs.forEach((reg) => {
        if (!reg.spl) return;
        probeSpl(reg.spl).collections.forEach((c) => {
            if (collections.indexOf(c) === -1) collections.push(c);
        });
    });
    return collectProducerSpl(runner, collections);
};

/**
 * Diagnose one dashboard's registered searches.
 *
 * Free checks run on EVERY entry (they cost a memoised regex parse). The
 * dispatched cascade runs only on the EMPTY ones — an errored panel's verdict
 * is its own error message, already conclusive and free; an OK panel needs no
 * explanation; a not-dispatched panel is waiting on the user.
 */
export const sweepDashboard = async (
    runner: ProbeRunner,
    regs: RegistrationLike[],
    cloudProvider: string | undefined,
    onProgress?: (done: number, total: number) => void,
): Promise<SweepResult> => {
    const memo = createMemoizingRunner(runner);

    const entries: SweepEntry[] = regs.map((reg, index) => {
        const probe: SplProbe = probeSpl(reg.spl);
        const facts: PanelFacts = {
            spl: reg.spl,
            earliest: reg.earliest,
            latest: reg.latest,
            dispatched: reg.dispatched,
            loading: false,
            errorMessage: reg.errorMessage,
            rowCount: reg.rowCount,
            cloudProvider,
        };
        return {
            index,
            descriptor: describeSearch(probe, reg.spl),
            spl: reg.spl,
            earliest: reg.earliest,
            latest: reg.latest,
            rowCount: reg.rowCount,
            errorMessage: reg.errorMessage,
            classification: classifyRegistration(reg),
            freeVerdict: reg.spl ? explainEmptyPanel(facts) : null,
        };
    });

    const targets = entries.filter((e) => e.classification === 'empty');
    let diagnosedCount = 0;
    let budgetExhausted = false;

    for (let i = 0; i < targets.length; i += 1) {
        const e = targets[i];
        if (onProgress) onProgress(i, targets.length);
        if (runner.isCancelled() || runner.remainingMs() <= 0) {
            budgetExhausted = true;
            break;
        }
        const probe = probeSpl(e.spl);
        const facts: PanelFacts = {
            spl: e.spl,
            earliest: e.earliest,
            latest: e.latest,
            dispatched: true,
            loading: false,
            errorMessage: e.errorMessage,
            rowCount: e.rowCount,
            cloudProvider,
        };
        // eslint-disable-next-line no-await-in-loop
        const evidence = await gatherPanelEvidence(memo, probe, e.earliest, e.latest);
        e.evidence = evidence;
        e.diag = diagnosePanel(facts, evidence);
        diagnosedCount += 1;
        if (evidence.budgetExhausted) budgetExhausted = true;
    }
    if (onProgress) onProgress(targets.length, targets.length);

    return { entries, diagnosedCount, budgetExhausted };
};
