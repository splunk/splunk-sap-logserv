import { useMemo } from 'react';
import { useSearch } from './useSearch';
import {
    SEARCH_NODE_HOURLY,
    SEARCH_NODE_PROGRAMS,
    SEARCH_NODE_ERRORS,
    SEARCH_NODE_HOSTS,
} from '../topology/searches';

/**
 * useNodeData — per-selected-node SPL data for the right sidebar's
 * inline charts and the Top Programs / Errors / Hosts tabs.
 *
 * Hourly chart hardcoded to -24h (matches the bottom panel sparkline behavior
 * — stable recent context regardless of the global TimeRange).
 * Programs / Errors / Hosts respect the global TimeRange (so admins can
 * compare patterns over different windows).
 *
 * Returns nulls when nothing is selected so the sidebar can render
 * empty-state messages without checking the search results separately.
 */

interface HourlyRow {
    _time: string;
    count: string | number;
}

interface ProgramRow {
    icm_program: string;
    count: string | number;
}

interface ErrorRow {
    sourcetype: string;
    error_kind: string;
    count: string | number;
    last_seen: string | number;
}

interface HostRow {
    host: string;
    count: string | number;
    sourcetypes: string | number;
    /** Build 325 — SAP instance numbers seen on this host (multivalue; the
     *  REST JSON returns an array for 2+, a bare string for exactly 1, and
     *  omits the field on rows aggregated before the change). */
    instances?: string | string[];
    first_seen: string | number;
    last_seen: string | number;
    /** Pre-cap distinct-host count, repeated on every row (build 322). */
    host_total?: string | number;
}

export interface NodeProgram {
    program: string;
    count: number;
}

export interface NodeError {
    sourcetype: string;
    errorKind: string;
    count: number;
    /** Epoch seconds — formatted at render time. */
    lastSeen: number;
}

export interface NodeHost {
    host: string;
    count: number;
    sourcetypeCount: number;
    /** Build 325 — SAP instance numbers seen on this host in the window
     *  (e.g. ['00', '01']). Undefined when the rollup rows carry none —
     *  either no sap_inst on the events, or rows aggregated before the
     *  instances measure existed. */
    instances?: string[];
    /** Epoch seconds — formatted at render time. */
    firstSeen: number;
    lastSeen: number;
}

export interface UseNodeDataResult {
    hourly: number[] | null;
    hourlyLoading: boolean;
    hourlyError: Error | null;
    programs: NodeProgram[] | null;
    programsLoading: boolean;
    programsError: Error | null;
    errors: NodeError[] | null;
    errorsLoading: boolean;
    errorsError: Error | null;
    hosts: NodeHost[] | null;
    hostsLoading: boolean;
    hostsError: Error | null;
    /** Distinct hosts BEFORE the read's `head` cap, so the panel can disclose a
     *  truncation instead of presenting the cap as the count (build 322).
     *  null when nothing has returned yet. */
    hostTotal: number | null;
}

const num = (v: string | number | undefined): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
};

/** Normalize a Splunk multivalue field: the REST JSON returns an array for
 *  2+ values, a bare string for exactly 1, and omits the field entirely for
 *  none. Returns undefined for none/empty so callers can gate the render. */
const toMv = (v: string | string[] | undefined): string[] | undefined => {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    const clean = arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return clean.length > 0 ? clean : undefined;
};

/** Splunk's `_time`-style fields come back as ISO strings or epoch numbers
 *  depending on the search; normalize to epoch seconds. Returns 0 on parse
 *  failure (caller renders as "—"). */
const toEpoch = (v: string | number | undefined): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v !== 'string' || !v) return 0;
    // Try numeric epoch first
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    // Try ISO date
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

export const useNodeData = (nodeId: string | null, refreshNonce = 0): UseNodeDataResult => {
    const hourlyQuery = nodeId ? SEARCH_NODE_HOURLY(nodeId) : null;
    const hourlyResult = useSearch<HourlyRow>({
        query: hourlyQuery ?? '',
        enabled: !!hourlyQuery,
        // Hardcode the per-node hourly to recent 24h regardless of global time
        // range. The bar chart's purpose is "what's happening on this node
        // right now?", not "trend over the global range".
        earliest: '-24h',
        latest: 'now',
        refreshNonce,
    });

    const programsQuery = nodeId ? SEARCH_NODE_PROGRAMS(nodeId) : null;
    const programsResult = useSearch<ProgramRow>({
        query: programsQuery ?? '',
        enabled: !!programsQuery,
        // Programs follow the global TimeRange so admins can scope to a
        // specific window — they're a longer-trend signal than hourly counts.
        refreshNonce,
    });

    const errorsQuery = nodeId ? SEARCH_NODE_ERRORS(nodeId) : null;
    const errorsResult = useSearch<ErrorRow>({
        query: errorsQuery ?? '',
        enabled: !!errorsQuery,
        // Errors follow the global TimeRange so admins can scope error
        // analysis to specific incident windows.
        refreshNonce,
    });

    const hostsQuery = nodeId ? SEARCH_NODE_HOSTS(nodeId) : null;
    const hostsResult = useSearch<HostRow>({
        query: hostsQuery ?? '',
        enabled: !!hostsQuery,
        // Hosts follow the global TimeRange — first_seen/last_seen are
        // bounded by the search window, which is what admins expect when
        // they're scoping a period.
        refreshNonce,
    });

    return useMemo<UseNodeDataResult>(() => {
        if (!nodeId) {
            return {
                hourly: null, hourlyLoading: false, hourlyError: null,
                programs: null, programsLoading: false, programsError: null,
                errors: null, errorsLoading: false, errorsError: null,
                hosts: null, hostsLoading: false, hostsError: null,
                hostTotal: null,
            };
        }
        const hourly = hourlyResult.results
            ? hourlyResult.results.map((r) => num(r.count))
            : null;
        const programs = programsResult.results
            ? programsResult.results.map((r) => ({
                program: r.icm_program,
                count: num(r.count),
            }))
            : null;
        const errors = errorsResult.results
            ? errorsResult.results.map((r) => ({
                sourcetype: r.sourcetype,
                errorKind: r.error_kind,
                count: num(r.count),
                lastSeen: toEpoch(r.last_seen),
            }))
            : null;
        const hosts = hostsResult.results
            ? hostsResult.results.map((r) => ({
                host: r.host,
                count: num(r.count),
                sourcetypeCount: num(r.sourcetypes),
                instances: toMv(r.instances),
                firstSeen: toEpoch(r.first_seen),
                lastSeen: toEpoch(r.last_seen),
            }))
            : null;
        /* Every row carries the same eventstats value; read it off the first.
         * Falls back to the returned row count so the caption never claims a
         * total it does not have (an older rollup read, mid-deploy, has no
         * host_total field). */
        const firstHostRow = hostsResult.results && hostsResult.results.length > 0
            ? hostsResult.results[0]
            : null;
        const hostTotal = hosts === null
            ? null
            : (firstHostRow && firstHostRow.host_total != null
                ? num(firstHostRow.host_total)
                : hosts.length);
        return {
            hourly,
            hourlyLoading: hourlyResult.loading,
            hourlyError: hourlyResult.error,
            programs,
            programsLoading: programsResult.loading,
            programsError: programsResult.error,
            errors,
            errorsLoading: errorsResult.loading,
            errorsError: errorsResult.error,
            hosts,
            hostsLoading: hostsResult.loading,
            hostsError: hostsResult.error,
            hostTotal,
        };
    }, [nodeId,
        hourlyResult.results, hourlyResult.loading, hourlyResult.error,
        programsResult.results, programsResult.loading, programsResult.error,
        errorsResult.results, errorsResult.loading, errorsResult.error,
        hostsResult.results, hostsResult.loading, hostsResult.error]);
};
