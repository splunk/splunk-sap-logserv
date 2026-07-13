import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
} from 'react';
// `username` is a runtime constant exposed by Splunk Web's `window.$C`
// global. Empty string outside Splunk Web (tests / local dev).
import { username as splunkUsername } from '@splunk/splunk-utils/config';

/**
 * CloudProviderProvider — global cloud-provider filter (session 082).
 *
 * One selection applies across EVERY dashboard (except Multi-Cloud
 * Overview, Environment Topology, and Settings — those opt out via
 * DashboardLayout's `noCloudFilter`). Behaves like the global TimeRange
 * picker: the choice is app-wide and persisted per user, so navigating
 * between dashboards keeps the same provider filter in effect.
 *
 * Persistence is a synchronous localStorage read/write keyed
 * `logserv.cloudProvider.<user>` (per-user, per-browser — session-036
 * sticky #23 naming). Synchronous means no hydration flicker: the
 * initial value is available at first render, unlike the KV-Store-backed
 * RefreshProvider.
 *
 * Semantics of the value:
 *  - 'all'  → no cloud_provider clause is spliced into any panel read
 *             (dashboards sum across the new rollup grain dim).
 *  - 'aws' | 'azure' | 'gcp' → panel reads filter to that provider. The
 *             null-provider convention (events with no cloud_provider
 *             field) is baked at aggregation time as coalesce(...,"aws"),
 *             matching Multi-Cloud Overview, so 'aws' includes them.
 */

export type CloudProvider = 'all' | 'aws' | 'azure' | 'gcp';

const VALID: readonly CloudProvider[] = ['all', 'aws', 'azure', 'gcp'];

const storageKey = (): string => {
    const u =
        typeof splunkUsername === 'string' && splunkUsername ? splunkUsername : 'anonymous';
    return `logserv.cloudProvider.${u}`;
};

const readInitial = (): CloudProvider => {
    try {
        const v = window.localStorage.getItem(storageKey());
        if (v && (VALID as readonly string[]).includes(v)) return v as CloudProvider;
    } catch (_e) {
        /* ignore — private mode / disabled storage */
    }
    return 'all';
};

interface CloudProviderContextValue {
    provider: CloudProvider;
    setProvider: (p: CloudProvider) => void;
}

const CloudProviderContext = createContext<CloudProviderContextValue>({
    provider: 'all',
    setProvider: () => undefined,
});

export const CloudProviderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [provider, setProviderState] = useState<CloudProvider>(() => readInitial());

    const setProvider = useCallback((next: CloudProvider): void => {
        setProviderState(next);
        try {
            window.localStorage.setItem(storageKey(), next);
        } catch (_e) {
            /* ignore */
        }
    }, []);

    const value = useMemo<CloudProviderContextValue>(
        () => ({ provider, setProvider }),
        [provider, setProvider],
    );

    return (
        <CloudProviderContext.Provider value={value}>{children}</CloudProviderContext.Provider>
    );
};

/** Read the global cloud-provider filter. Returns the 'all' default when
 *  used outside a provider (tests / standalone rendering). */
export const useCloudProvider = (): CloudProviderContextValue => useContext(CloudProviderContext);

/**
 * cloudProviderClause — the SPL fragment to splice into a rollup read or
 * raw/tstats search for the given provider. Returns '' for 'all' (no
 * filter). For a specific provider, `cloud_provider="<p>"` — the
 * aggregation bakes null→aws, so no OR-null form is needed on rollup
 * reads. Callers that touch RAW/tstats where cloud_provider is NOT
 * pre-coalesced should use `cloudProviderClauseRaw` instead.
 */
export const cloudProviderClause = (p: CloudProvider): string =>
    p === 'all' ? '' : `cloud_provider="${p}"`;

/**
 * cloudProviderRollupPipe — the ` | search cloud_provider="<p>"` fragment to
 * splice into a KV-Store rollup read AFTER the `| addinfo | where bucket_ts…`
 * range filter and BEFORE the aggregation. Empty string for 'all'. The rollup
 * grain stores cloud_provider already coalesced to a real value (never null),
 * so no OR-null form is needed here — unlike raw/tstats reads.
 */
export const cloudProviderRollupPipe = (p: CloudProvider): string =>
    p === 'all' ? '' : ` | search cloud_provider="${p}"`;

/**
 * cloudProviderClauseRaw — like cloudProviderClause but for RAW event /
 * tstats searches over sap_logserv_logs where cloud_provider is the
 * index-time WRITE_META field and may be genuinely absent on some events.
 * For 'aws' it also matches null-provider events, matching the
 * coalesce(cloud_provider,"aws") convention used everywhere else.
 * Returns a bare boolean expression (no leading AND).
 */
export const cloudProviderClauseRaw = (p: CloudProvider): string => {
    if (p === 'all') return '';
    if (p === 'aws') return '(cloud_provider="aws" OR NOT cloud_provider=*)';
    return `cloud_provider="${p}"`;
};

/**
 * cloudProviderRawTerm — cloudProviderClauseRaw prefixed with a leading space
 * (empty for 'all'). Splice directly into a tstats WHERE clause or a raw
 * event-search base predicate — no per-call-site conditional needed.
 */
export const cloudProviderRawTerm = (p: CloudProvider): string => {
    const c = cloudProviderClauseRaw(p);
    return c ? ` ${c}` : '';
};

// The canonical KV-Store rollup range-filter fragments (session 050+). Every
// rollup read splices one of these; cloud_provider gets injected right after it,
// before the aggregation. Kept as exact-match constants so withCloudProvider is
// a pure, deterministic string transform.
const RANGE_BUCKET = '| where bucket_ts>=info_min_time AND bucket_ts<info_max_time';
const RANGE_DAY = '| where day_ts>=info_min_time AND day_ts<info_max_time';
const IDX_MACRO = '`sap_logserv_idx_macro`';

/**
 * withCloudProvider — apply the global cloud-provider filter to ONE dashboard
 * query string (session 082). Returns the query unchanged for 'all'. Two
 * injection sites, mutually exclusive per query:
 *
 *   - KV-Store rollup reads (`| inputlookup … | addinfo | where <t>_ts …`):
 *     append ` | search cloud_provider="x"` right after the range filter and
 *     before the aggregation. The rollup grain stores cloud_provider (coalesced
 *     to a real value), so a plain equality is exact.
 *   - tstats / raw event reads (over `sap_logserv_idx_macro`): inject the raw
 *     term ` (cloud_provider="aws" OR NOT cloud_provider=*)` (or `="x"`) right
 *     after the index macro — valid both as a tstats WHERE term and a raw base
 *     predicate. The OR-null form keeps null-provider events under "aws",
 *     matching the coalesce convention baked into the rollups.
 *
 * A given query is one type or the other (rollup reads use inputlookup, never
 * the macro), so applying both replacements is safe. Callers on the excluded
 * dashboards (Multi-Cloud / Topology / Settings) simply don't invoke this.
 */
export function withCloudProvider(query: string, p: CloudProvider): string {
    if (p === 'all') return query;
    const pipe = cloudProviderRollupPipe(p);
    const rawTerm = cloudProviderRawTerm(p);
    let q = query;
    q = q.split(RANGE_BUCKET).join(RANGE_BUCKET + pipe);
    q = q.split(RANGE_DAY).join(RANGE_DAY + pipe);
    q = q.split(IDX_MACRO).join(IDX_MACRO + rawTerm);
    return q;
}

/**
 * mapCloudProviderQueries — apply withCloudProvider to every value of a query
 * map, preserving its shape/type. Returns the input unchanged for 'all'. Wrap
 * a dashboard's module-level query object in a useMemo over this so panels
 * re-run when the picker changes.
 */
export function mapCloudProviderQueries<T extends Record<string, string>>(
    base: T,
    p: CloudProvider,
): T {
    if (p === 'all') return base;
    const out: Record<string, string> = {};
    for (const k of Object.keys(base)) out[k] = withCloudProvider(base[k], p);
    return out as T;
}
