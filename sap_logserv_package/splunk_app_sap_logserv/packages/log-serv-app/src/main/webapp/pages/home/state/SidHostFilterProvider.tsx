import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
// `username` is a runtime constant exposed by Splunk Web's `window.$C`
// global. Empty string outside Splunk Web (tests / local dev).
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { useSearch } from '../hooks/useSearch';
import { FilterKeyContext } from './FilterKeyContext';
import { CloudProvider, useCloudProvider, withCloudProvider } from './CloudProviderProvider';
import { useTimeRange } from './TimeRangeProvider';
import { kvWindowLowerBound } from '../utils/kvWindow';
import { HOST_GATE_TIMEOUT_MS, HOST_GATE_TTL_MS, readHostGate, uniformHostGate } from '../utils/hostGate';
import { onServerClockSettled, serverClockSettled, serverNowSec } from '../utils/serverClock';
import {
    FilterTerms,
    HOST_OUTSIDE_SID,
    HostGateState,
    SidHostSelection,
    ownHostsInScope,
    picksCameFromOutside,
    termsOf,
    withSidHostTerms,
} from '../utils/queryFilters';
import {
    EMPTY_SID_HOST_MAP,
    SidHostMap,
    SidHostRow,
    buildSidHostMap,
    describeHost,
    findSid,
    isSidName,
    scopeOf,
} from '../utils/sidHostMap';

/**
 * SidHostFilterProvider — the global SID and Host filters (build 395).
 *
 * Behaves like the global Cloud filter: one selection across the dashboards,
 * persisted per user, with a synchronous localStorage read so the first render
 * already knows it. That matters more here, because a persisted SID has to be
 * expanded to its hosts before a panel may dispatch: the expansion is stored with
 * the selection, so a page load never shows a filtered page unfiltered while the
 * list loads. The list then refreshes the stored expansion.
 *
 * Three kinds of page:
 *  - SID and Host: the default. Both pickers, one shared selection.
 *  - Host only: SAP Router, Proxy, DNS and Cloud Connector. Their hosts belong
 *    to no SID, so a SID filter would just empty them. Each keeps its own host
 *    selection, because a proxy host means nothing on another dashboard.
 *  - Out: every page with `noCloudFilter`.
 *
 * Host Details and Data Pipeline Overview have their own host picker, which
 * works inside the selected SID (`useSidScope`).
 *
 * Build 397: while the SID or Host selection is on, it also keeps the answer to "can
 * the metrics that gained `host` take the filter over this time range?"
 * (`utils/hostGate.ts`). With nothing selected that check never runs.
 */

export type HostService = 'saprouter' | 'proxy' | 'dns' | 'cloudconnector';

/** The hosts each Host-only dashboard can filter on: those with its events. */
const SERVICE_HOST_QUERY: Record<HostService, string> = {
    saprouter: '| tstats count WHERE `sap_logserv_idx_macro` sourcetype="sap:saprouter" BY host | sort -count',
    proxy: '| tstats count WHERE `sap_logserv_idx_macro` sourcetype="squid:access" BY host | sort -count',
    dns: '| tstats count WHERE `sap_logserv_idx_macro` sourcetype="isc:bind:*" BY host | sort -count',
    cloudconnector:
        '| tstats count WHERE `sap_logserv_idx_macro` sourcetype="sap:scc:*" BY host | sort -count',
};

/** 90 days: a host moved to another system stops counting for the old one. The
 *  collection keeps a year; the list is meant to describe the systems as they are. */
const MAP_QUERY =
    '| inputlookup logserv_sid_hosts | where last_seen >= relative_time(now(), "-90d") | fields sid, host, role, tenant';

/** Every host with events in the time range, for the Host filter with no SID
 *  selected: a Windows or plain Linux host has no SID evidence, and must be
 *  pickable on the dashboards that show it. */
const ALL_HOSTS_QUERY = '| tstats count WHERE `sap_logserv_idx_macro` BY host | sort -count';

const NO_SELECTION: SidHostSelection = { sid: null, hosts: [], scopeHosts: [], scopeSids: [] };

const storageUser = (): string =>
    (typeof splunkUsername === 'string' && splunkUsername ? splunkUsername : 'anonymous');
const selectionKey = (): string => `logserv.sidHostFilter.${storageUser()}`;
const serviceKey = (): string => `logserv.serviceHostFilter.${storageUser()}`;

const stringList = (v: unknown): string[] =>
    (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

const readSelection = (): SidHostSelection => {
    try {
        const raw = window.localStorage.getItem(selectionKey());
        if (!raw) return NO_SELECTION;
        const o = JSON.parse(raw) as Record<string, unknown>;
        const sid = typeof o.sid === 'string' && isSidName(o.sid) ? o.sid : null;
        const scopeHosts = stringList(o.scopeHosts);
        // A SID with nothing to stand for would read "SID: X" over unfiltered panels.
        if (sid && scopeHosts.length === 0) return NO_SELECTION;
        return {
            sid,
            hosts: stringList(o.hosts),
            scopeHosts: sid ? scopeHosts : [],
            scopeSids: sid ? stringList(o.scopeSids).filter(isSidName) : [],
        };
    } catch (_e) {
        /* ignore — private mode / disabled storage / a damaged value */
        return NO_SELECTION;
    }
};

const readServiceHosts = (): Partial<Record<HostService, string[]>> => {
    try {
        const raw = window.localStorage.getItem(serviceKey());
        if (!raw) return {};
        const o = JSON.parse(raw) as Record<string, unknown>;
        const out: Partial<Record<HostService, string[]>> = {};
        (Object.keys(SERVICE_HOST_QUERY) as HostService[]).forEach((s) => {
            const list = stringList(o[s]);
            if (list.length > 0) out[s] = list;
        });
        return out;
    } catch (_e) {
        /* ignore — private mode / disabled storage / a damaged value */
        return {};
    }
};

const write = (key: string, value: unknown): void => {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_e) {
        /* ignore */
    }
};

interface SidHostFilterContextValue {
    map: SidHostMap;
    mapLoading: boolean;
    /** The list could not be read: not the same as "nothing listed yet". */
    mapFailed: boolean;
    /** Read the list again: it may have been built since the page loaded. */
    refreshMap: () => void;
    /** Hosts with events in the time range, once `requestAllHosts` asked for them. */
    allHostNames: string[];
    allHostsLoading: boolean;
    requestAllHosts: () => void;
    selection: SidHostSelection;
    setSid: (sid: string | null) => void;
    setHosts: (hosts: string[]) => void;
    serviceHosts: Partial<Record<HostService, string[]>>;
    setServiceHosts: (service: HostService, hosts: string[]) => void;
    /** The hosts the current Host-only page lists. */
    serviceHostOptions: string[];
    serviceHostsLoading: boolean;
    /** Tells the provider which Host-only page is showing (null when none). */
    setActiveService: (service: HostService | null) => void;
    /** Per metric that gained `host` in build 397: see FilterTerms.hostGate. */
    hostGate: Readonly<Record<string, HostGateState>>;
}

const SidHostFilterContext = createContext<SidHostFilterContextValue>({
    map: EMPTY_SID_HOST_MAP,
    mapLoading: false,
    mapFailed: false,
    refreshMap: () => undefined,
    allHostNames: [],
    allHostsLoading: false,
    requestAllHosts: () => undefined,
    selection: NO_SELECTION,
    setSid: () => undefined,
    setHosts: () => undefined,
    serviceHosts: {},
    setServiceHosts: () => undefined,
    serviceHostOptions: [],
    serviceHostsLoading: false,
    setActiveService: () => undefined,
    hostGate: {},
});

/** Answers already read, per lower bound: moving between time ranges re-checks nothing
 *  for a while. Module-level, so a page change keeps them too. */
const hostGateAnswers = new Map<string, { at: number; states: Record<string, HostGateState> }>();
const hostGateAnswer = (key: string): Record<string, HostGateState> | null => {
    const hit = hostGateAnswers.get(key);
    return hit && Date.now() - hit.at < HOST_GATE_TTL_MS ? hit.states : null;
};

export const SidHostFilterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [selection, setSelectionState] = useState<SidHostSelection>(() => readSelection());
    const [serviceHosts, setServiceHostsState] = useState<Partial<Record<HostService, string[]>>>(
        () => readServiceHosts(),
    );
    const [activeService, setActiveService] = useState<HostService | null>(null);
    const [allHostsWanted, setAllHostsWanted] = useState<boolean>(false);
    const requestAllHosts = useCallback((): void => setAllHostsWanted(true), []);
    const { timeRange } = useTimeRange();

    // Both searches run here, above DashboardLayout, so they are not panels of
    // the page's Data Doctor registry. The list is a flat, small collection, and
    // `inputlookup` ignores the time range.
    const mapSearch = useSearch<SidHostRow>({ query: MAP_QUERY, earliest: '0', latest: 'now' });
    const serviceSearch = useSearch<{ host?: unknown }>({
        query: activeService ? SERVICE_HOST_QUERY[activeService] : '',
        enabled: !!activeService,
    });

    const allHostsSearch = useSearch<{ host?: unknown }>({ query: ALL_HOSTS_QUERY, enabled: allHostsWanted });
    const allHostNames = useMemo<string[]>(
        () => (allHostsSearch.results ?? []).map((r) => String(r.host ?? '')).filter((h) => h.length > 0),
        [allHostsSearch.results],
    );

    const map = useMemo<SidHostMap>(
        () => (mapSearch.results ? buildSidHostMap(mapSearch.results) : EMPTY_SID_HOST_MAP),
        [mapSearch.results],
    );
    // Nothing while loading: `results` still holds the previous page's hosts then.
    const serviceHostOptions = useMemo<string[]>(
        () =>
            (serviceSearch.loading ? [] : serviceSearch.results ?? [])
                .map((r) => String(r.host ?? ''))
                .filter((h) => h.length > 0),
        [serviceSearch.loading, serviceSearch.results],
    );

    const setSelection = useCallback((next: SidHostSelection): void => {
        setSelectionState(next);
        write(selectionKey(), next);
    }, []);

    // Refresh the stored expansion once the list is known. An empty list says
    // nothing (it may not be built yet, or the read failed), so it changes
    // nothing: a stored selection then stays as it was.
    useEffect(() => {
        if (map.sids.length === 0) return;
        const prev = readSelection();
        if (!prev.sid) return;
        const entry = findSid(map, prev.sid);
        if (!entry) {
            setSelection(NO_SELECTION);
            return;
        }
        const scope = scopeOf(entry);
        setSelection({
            sid: prev.sid,
            hosts: prev.hosts.filter((h) => scope.scopeHosts.indexOf(h) !== -1),
            ...scope,
        });
    }, [map, setSelection]);

    const setSid = useCallback(
        (sid: string | null): void => {
            const entry = findSid(map, sid);
            setSelection(entry ? { sid: entry.sid, hosts: [], ...scopeOf(entry) } : NO_SELECTION);
        },
        [map, setSelection],
    );

    const setHosts = useCallback(
        (hosts: string[]): void => {
            setSelectionState((prev) => {
                const next = { ...prev, hosts };
                write(selectionKey(), next);
                return next;
            });
        },
        [],
    );

    const setServiceHosts = useCallback((service: HostService, hosts: string[]): void => {
        setServiceHostsState((prev) => {
            const next = { ...prev, [service]: hosts };
            write(serviceKey(), next);
            return next;
        });
    }, []);

    // Build 397 - the check, only while the selection is on. The bound is a whole UTC
    // day, so it changes with the time range and at midnight, not on every render. It
    // waits for the server's clock: a browser clock days fast must not move it.
    const selectionOn = !!termsOf(selection);
    const [clockSettled, setClockSettled] = useState<boolean>(() => serverClockSettled());
    useEffect(() => {
        let left = false;
        serverNowSec(); // starts the read
        onServerClockSettled(() => {
            if (!left) setClockSettled(true);
        });
        return () => {
            left = true;
        };
    }, []);
    const gateBound = selectionOn && clockSettled ? kvWindowLowerBound(timeRange.earliest, serverNowSec()) : null;
    const gateKey = selectionOn && clockSettled ? String(gateBound) : '';
    const [gateRead, setGateRead] = useState<{ bound: number | null; states: Record<string, HostGateState> } | null>(null);
    // Read again while the filter stays on: a Clear then Backfill moves a metric to
    // 'ready', and an answer read during a warm-up must not stand for the page's life.
    const [gateTick, setGateTick] = useState<number>(0);
    useEffect(() => {
        if (!gateKey) return undefined;
        const timer = window.setInterval(() => setGateTick((n) => n + 1), HOST_GATE_TTL_MS);
        return () => window.clearInterval(timer);
    }, [gateKey]);
    const lastTick = useRef<number>(gateTick);
    useEffect(() => {
        if (!gateKey) return undefined;
        // A tick means read again: the answer it would find was stored just after the
        // timer started, so it has not quite expired, and the re-read would wait a whole
        // period more.
        const ticked = lastTick.current !== gateTick;
        lastTick.current = gateTick;
        const known = ticked ? null : hostGateAnswer(gateKey);
        if (known) {
            setGateRead({ bound: gateBound, states: known });
            return undefined;
        }
        let left = false;
        const aborter = new AbortController();
        const timer = window.setTimeout(() => aborter.abort(), HOST_GATE_TIMEOUT_MS);
        readHostGate(gateBound, aborter.signal).then((states) => {
            window.clearTimeout(timer);
            // The range or selection moved on: these reads were aborted, so their 'old'
            // says nothing. A timeout does count: the metrics it cut short stay 'old'.
            if (left) return;
            hostGateAnswers.set(gateKey, { at: Date.now(), states });
            setGateRead({ bound: gateBound, states });
        });
        return () => {
            left = true;
            window.clearTimeout(timer);
            aborter.abort();
        };
        // `gateBound` is what `gateKey` spells.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gateKey, gateTick]);
    // During render, so no query is built from an answer that does not cover its range.
    // An answer covers any later bound: midnight, or a shorter range, clears no panel.
    const hostGate = useMemo<Readonly<Record<string, HostGateState>>>(() => {
        if (!selectionOn) return {};
        if (!gateKey) return uniformHostGate('pending');
        const covers = !!gateRead && (gateRead.bound === null || (gateBound !== null && gateBound >= gateRead.bound));
        return covers && gateRead ? gateRead.states : uniformHostGate('pending');
        // `gateBound` is what `gateKey` spells.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectionOn, gateKey, gateRead]);

    const value = useMemo<SidHostFilterContextValue>(
        () => ({
            map,
            mapLoading: mapSearch.loading,
            mapFailed: !!mapSearch.error,
            refreshMap: mapSearch.refresh,
            allHostNames,
            allHostsLoading: allHostsSearch.loading,
            requestAllHosts,
            selection,
            setSid,
            setHosts,
            serviceHosts,
            setServiceHosts,
            serviceHostOptions,
            serviceHostsLoading: serviceSearch.loading,
            setActiveService,
            hostGate,
        }),
        [
            map,
            mapSearch.loading,
            mapSearch.error,
            mapSearch.refresh,
            allHostNames,
            allHostsSearch.loading,
            requestAllHosts,
            selection,
            setSid,
            setHosts,
            serviceHosts,
            setServiceHosts,
            serviceHostOptions,
            serviceSearch.loading,
            hostGate,
        ],
    );

    // What `useSearch` compares to tell rows from before a filter change. Only the
    // lists in force: clearing an empty list changes no panel.
    const filterKey = JSON.stringify([
        termsOf(selection),
        (Object.keys(serviceHosts) as HostService[]).sort().filter((s) => (serviceHosts[s] ?? []).length > 0)
            .map((s) => [s, serviceHosts[s]]),
    ]);

    return (
        <SidHostFilterContext.Provider value={value}>
            <FilterKeyContext.Provider value={filterKey}>{children}</FilterKeyContext.Provider>
        </SidHostFilterContext.Provider>
    );
};

/** Read the selection. Returns "nothing selected" outside a provider. */
export const useSidHostFilter = (): SidHostFilterContextValue => useContext(SidHostFilterContext);

/**
 * For a page with its own host picker: the selected SID, and the hosts its picker
 * may offer and its panels are limited to. Empty when no SID is selected. A host
 * picked by hand on another dashboard does not narrow these pages; their own
 * picker does that.
 */
export const useSidScope = (): { sid: string | null; scopeHosts: string[] } => {
    const { sid, scopeHosts } = useSidHostFilter().selection;
    return { sid, scopeHosts };
};

const NO_PICKS: string[] = [];

export interface OwnPicks {
    /** The hosts this page's panels show. */
    effectiveHosts: string[];
    /** Every pick is outside the selected SID: a link to another host. */
    pickedOutsideSid: boolean;
    /** Wrap the panels in a FilterKeyContext.Provider with this, so a pick made while
     *  a SID is on clears their rows as the global Host filter does. With no SID it
     *  is the parent's key: the page's picker behaves as it always has. */
    ownFilterKey: string;
}

/**
 * For a page with its own host picker: what its picks mean under the selected SID.
 * Picks made under one system do not carry to the next; dropped during render, so
 * the page never commits (or searches) a pick the new SID does not hold.
 */
export const useOwnPicks = (selectedHosts: string[], clearPicks: () => void): OwnPicks => {
    const { sid, scopeHosts } = useSidScope();
    const parentKey = useContext(FilterKeyContext);
    const prev = useRef({ sid, scopeHosts });
    const dropPicks =
        prev.current.sid !== sid && !picksCameFromOutside(selectedHosts, prev.current.sid, prev.current.scopeHosts);
    const picks = dropPicks ? NO_PICKS : selectedHosts;
    useEffect(() => {
        prev.current = { sid, scopeHosts };
        if (dropPicks && selectedHosts.length > 0) clearPicks();
        // Runs on the SID's change: the rest is read as of that render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sid, scopeHosts]);
    const effectiveHosts = useMemo<string[]>(() => ownHostsInScope(picks, scopeHosts), [picks, scopeHosts]);
    return {
        effectiveHosts,
        pickedOutsideSid: effectiveHosts.length === 1 && effectiveHosts[0] === HOST_OUTSIDE_SID,
        ownFilterKey: sid ? JSON.stringify(effectiveHosts) : parentKey,
    };
};

/** What the Host filter shows beside a host, for a page with its own picker. */
export const useSidHostDescriptions = (): ((host: string) => string) => {
    const { map, selection } = useSidHostFilter();
    return useMemo(() => {
        const entry = findSid(map, selection.sid);
        const byHost: Record<string, string> = {};
        (entry ? entry.hosts : map.hosts).forEach((h) => {
            byHost[h.host] = describeHost(h);
        });
        return (host: string) => byHost[host] || '';
    }, [map, selection.sid]);
};

export interface QueryFilters {
    cloud: CloudProvider;
    terms: FilterTerms | null;
}

/**
 * Everything the global filters apply to a dashboard's queries. Pass the service
 * on a Host-only page. Stable across renders while the filters are unchanged, so
 * it is safe in a useMemo dependency list; panels re-run when it changes.
 */
export const useQueryFilters = (service?: HostService): QueryFilters => {
    const { provider } = useCloudProvider();
    const { selection, serviceHosts, hostGate } = useSidHostFilter();
    const picked = service ? serviceHosts[service] ?? [] : [];
    let terms: FilterTerms | null;
    if (service) terms = picked.length > 0 ? { hosts: picked, sids: [] } : null;
    else {
        const t = termsOf(selection);
        terms = t ? { ...t, hostGate } : null;
    }
    const key = terms ? JSON.stringify(terms) : '';
    return useMemo<QueryFilters>(
        () => ({ cloud: provider, terms }),
        // `terms` is rebuilt every render; `key` is what identifies it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [provider, key],
    );
};

/** Apply the global filters to one query. */
export function withQueryFilters(query: string, f: QueryFilters): string {
    return withSidHostTerms(withCloudProvider(query, f.cloud), f.terms);
}

/** Apply the global filters to every value of a query map, keeping its shape. */
export function mapQueryFilters<T extends Record<string, string>>(base: T, f: QueryFilters): T {
    if (f.cloud === 'all' && !f.terms) return base;
    const out: Record<string, string> = {};
    Object.keys(base).forEach((k) => {
        out[k] = withQueryFilters(base[k], f);
    });
    return out as T;
}
