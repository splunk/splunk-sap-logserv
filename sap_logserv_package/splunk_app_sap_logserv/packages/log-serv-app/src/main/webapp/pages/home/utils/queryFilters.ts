import {
    COMPOUND_SAP_SID_COLLECTIONS,
    metricGainedHost,
    metricStoresHost,
    metricStoresSapSid,
} from './filterCapability';

/**
 * queryFilters — apply the SID and Host filters to one dashboard query (build 395).
 *
 * The same two injection sites as `withCloudProvider`, with one difference that
 * shapes everything below: every rollup row stores cloud_provider, but most do
 * not store `host`. So a rollup read takes one of three paths:
 *
 *   1. its metric stores `host`, and no row in the time range lacks it (a metric
 *      that gained `host` in build 397 can hold older rows without it, which the
 *      term would drop: `utils/hostGate.ts`)
 *                                -> ` | search (host="a" OR host="b")`
 *   2. its metric stores `sap_sid`, and a SID (not a host) is selected
 *                                -> ` | search (sap_sid="X")`
 *   3. neither                   -> FILTER_UNAVAILABLE_SPL for the whole query.
 *
 * The cardinal rule is that a panel must never show unfiltered numbers while a
 * filter is on. Anything this module cannot be sure about therefore comes back
 * as FILTER_UNAVAILABLE_SPL; `useRoutedQuery` then takes the panel's raw twin,
 * and a panel with no twin (a KPI sparkline, the beaconing panels) shows nothing
 * and says why.
 *
 * Raw and tstats reads take the host term right after the index macro, valid as
 * a raw base predicate and as a tstats WHERE term. With no filter the query
 * comes back unchanged, byte for byte.
 */

/**
 * Stands in for a query that cannot honour the filter. `useSearch` recognises it
 * and dispatches nothing; it is still a valid search that returns no rows, so a
 * path that does dispatch it (Open in Search) shows nothing rather than something
 * wrong.
 */
export const FILTER_UNAVAILABLE_SPL = '| makeresults | where 1=0 | eval logserv_filter="unavailable"';

export const isFilterUnavailable = (spl: string | null | undefined): boolean =>
    spl === FILTER_UNAVAILABLE_SPL;

/**
 * Stands in for a query whose read depends on a check still running: can this
 * metric take the filter over this time range? `useSearch` waits, showing its
 * loading state, and dispatches nothing; the check settles within seconds and the
 * query is rebuilt. Taking the raw arm meanwhile would start a page's worth of
 * searches only to cancel them.
 */
export const FILTER_PENDING_SPL = '| makeresults | where 1=0 | eval logserv_filter="pending"';

export const isFilterPending = (spl: string | null | undefined): boolean =>
    spl === FILTER_PENDING_SPL;

/** Can a metric that gained `host` in build 397 take the host term right now?
 *  'old': the time range holds rows without `host`. */
export type HostGateState = 'ready' | 'pending' | 'old';

export const hostGateKey = (collection: string, metric: string): string => `${collection}|${metric}`;

export interface FilterTerms {
    /** The hosts the panels are limited to. */
    hosts: readonly string[];
    /** The SIDs, when a SID is selected and no individual host: lets a rollup
     *  metric that stores `sap_sid` but not `host` stay on the rollup. Empty when
     *  hosts were picked by hand, since `sap_sid` cannot honour that. */
    sids: readonly string[];
    /** Per hostGateKey, for the metrics in HOST_ADDED_METRICS. Anything not listed
     *  here reads as 'old': the raw arm is slower, never wrong. */
    hostGate?: Readonly<Record<string, HostGateState>>;
}

/** What a panel's current rows were fetched under. */
export interface RowsFor {
    query: string;
    filterKey: string;
}

/**
 * True when the rows held for a panel are from before the SID or Host filter
 * changed: its query changed along with the filter, and the new rows have not
 * arrived. They must not be drawn, or a page reads "SID: X" over all-hosts numbers
 * until the search ends, half a minute on a raw read. A filter change that leaves
 * the query as it was (a host list, say) leaves the rows valid; a change with no
 * filter change (Cloud, the time range, a span) behaves as it always has.
 */
export const rowsAreStale = (rowsFor: RowsFor | null, query: string, filterKey: string): boolean =>
    !!rowsFor && rowsFor.filterKey !== filterKey && rowsFor.query !== query;

/** Matches no event: a link to a host outside the selected SID shows nothing and
 *  says so, rather than other hosts. */
export const HOST_OUTSIDE_SID = '(not a host of the selected SID)';

/** The hosts a page with its own picker shows: its picks inside the selected SID,
 *  or all of the SID's, or its picks alone with no SID selected. */
export const ownHostsInScope = (picks: string[], scopeHosts: string[]): string[] => {
    if (scopeHosts.length === 0) return picks;
    if (picks.length === 0) return scopeHosts;
    const inScope = picks.filter((h) => scopeHosts.indexOf(h) !== -1);
    return inScope.length > 0 ? inScope : [HOST_OUTSIDE_SID];
};

/** Picks that were already outside the SID being left came from a link, not from
 *  that system's list. They stand when the SID changes: the page told the reader to
 *  clear the SID to see them. Any other pick belongs to the system it was made under. */
export const picksCameFromOutside = (picks: string[], prevSid: string | null, prevScopeHosts: string[]): boolean =>
    !!prevSid && picks.length > 0 && picks.every((h) => prevScopeHosts.indexOf(h) === -1);

export interface SidHostSelection {
    /** The selected SID, or null. */
    sid: string | null;
    /** Hosts picked by hand. Empty means all of the SID's. */
    hosts: string[];
    /** Everything the SID stands for, its database's hosts included. */
    scopeHosts: string[];
    scopeSids: string[];
}

/** The terms a selection applies. A host picked by hand wins over the whole SID,
 *  and then `sids` stays empty: `sap_sid` cannot honour one host. */
export const termsOf = (s: SidHostSelection): FilterTerms | null => {
    if (s.hosts.length > 0) return { hosts: s.hosts, sids: [] };
    if (s.sid && s.scopeHosts.length > 0) return { hosts: s.scopeHosts, sids: s.scopeSids };
    return null;
};

const IDX_MACRO = '`sap_logserv_idx_macro`';

/** One rollup read: the collection, an optional metric, and the range filter
 *  every dashboard read splices. A read without that range filter does not match
 *  group 4, and is not filterable. */
const ROLLUP_READ =
    /\|\s*inputlookup\s+([^\s|]+)(\s+where\s+metric="([^"]*)")?(\s*\|\s*addinfo\s*\|\s*where\s+(?:bucket_ts|day_ts)>=info_min_time AND (?:bucket_ts|day_ts)<info_max_time)?/g;

const quote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** `host="a"`, or the OR-expanded group: the dialect valid in a tstats WHERE, and
 *  the one `splProbe.detectHostFilter` reads, so Data Doctor explains it. */
export const hostTerm = (hosts: readonly string[]): string => {
    if (hosts.length === 1) return `host="${quote(hosts[0])}"`;
    return `(${hosts.map((h) => `host="${quote(h)}"`).join(' OR ')})`;
};

/** `(sap_sid="X" OR sap_sid="Y")`. On a collection that can hold a compound
 *  monitoring value (see COMPOUND_SAP_SID_COLLECTIONS), each also matches `X_*`. */
export const sapSidTerm = (sids: readonly string[], compound: boolean): string => {
    const one = (s: string): string =>
        compound ? `sap_sid="${quote(s)}" OR sap_sid="${quote(s)}_*"` : `sap_sid="${quote(s)}"`;
    return `(${sids.map(one).join(' OR ')})`;
};

/** Stands in for a term while its metric's check is running. */
const PENDING_TERM = 'pending';

/** The ` | search` term for one rollup read, PENDING_TERM while that cannot be known
 *  yet, or null when it cannot take one. */
const rollupTerm = (collection: string, metric: string | null, terms: FilterTerms): string | null => {
    if (terms.hosts.length > 0 && metricStoresHost(collection, metric)) {
        const gate: HostGateState = metricGainedHost(collection, metric)
            ? (terms.hostGate && terms.hostGate[hostGateKey(collection, metric as string)]) || 'old'
            : 'ready';
        if (gate === 'ready') return hostTerm(terms.hosts);
        if (gate === 'pending') return PENDING_TERM;
    }
    if (terms.sids.length > 0 && metricStoresSapSid(collection, metric)) {
        return sapSidTerm(terms.sids, COMPOUND_SAP_SID_COLLECTIONS.indexOf(collection) !== -1);
    }
    return null;
};

/**
 * Apply the filter to one query. Null terms (no filter) return the query as it is.
 * Mirrors `withCloudProvider`: a pure string transform, applied after it.
 */
export function withSidHostTerms(query: string, terms: FilterTerms | null): string {
    if (!terms || (terms.hosts.length === 0 && terms.sids.length === 0)) return query;
    if (isFilterUnavailable(query) || isFilterPending(query)) return query;

    let blocked = false;
    let pending = false;
    let rollupReads = 0;
    const reads = query.replace(
        ROLLUP_READ,
        (match: string, collection: string, _where: string | undefined, metric: string | undefined, range: string | undefined) => {
            rollupReads += 1;
            const term = range ? rollupTerm(collection, metric === undefined ? null : metric, terms) : null;
            if (term === null) {
                blocked = true;
                return match;
            }
            if (term === PENDING_TERM) {
                pending = true;
                return match;
            }
            return `${match} | search ${term}`;
        },
    );
    if (blocked) return FILTER_UNAVAILABLE_SPL;
    if (pending) return FILTER_PENDING_SPL;

    if (reads.indexOf(IDX_MACRO) === -1) return rollupReads > 0 ? reads : FILTER_UNAVAILABLE_SPL;
    if (terms.hosts.length === 0) return FILTER_UNAVAILABLE_SPL;
    return reads.split(IDX_MACRO).join(`${IDX_MACRO} ${hostTerm(terms.hosts)}`);
}
