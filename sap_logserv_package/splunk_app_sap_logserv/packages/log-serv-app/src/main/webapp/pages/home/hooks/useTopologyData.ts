import { useMemo } from 'react';
import { useSearch } from './useSearch';
import {
    SEARCH_INVENTORY,
    SEARCH_RFC_EDGES,
    SEARCH_HANA_EDGES,
    SEARCH_HTTP_EDGES,
    SEARCH_HANA_TENANT_EDGES,
    SEARCH_ACTIVITY,
    SEARCH_CALLS_PER_HOUR,
} from '../topology/searches';
import type {
    TopologyNode,
    TopologyEdge,
    ActivityRow,
    NodeKind,
    SystemTag,
} from '../topology/types';

/**
 * useTopologyData — composite hook that runs 6 SPL searches in parallel
 * (auto-respecting the global TimeRange), enriches edge endpoints via a
 * self-derived IP/host -> SID inventory, and returns nodes + edges + activity
 * + sparkline data shaped identically to the fixtures.ts demo data so the
 * rendering layer doesn't change.
 *
 * Loading semantics: returns `{ loading: true }` until ALL searches have
 * resolved. Per-search errors are aggregated into `errors` (non-fatal —
 * partial data still renders).
 *
 * Self-derived IP/host -> SID resolution:
 *   - Inventory query returns rows { key, sid, kind } where key is an IP
 *     (from gateway L=) or hostname (from Splunk default host field) that
 *     uniquely belongs to one SID.
 *   - Edge endpoints (peer_ip from RFC, client_ip from HANA, clientip from
 *     web dispatcher, host from HANA/dispatcher) get resolved via the
 *     inventory map. Unresolved endpoints render as the raw IP.
 *
 * Empty-state behavior: when a search returns 0 rows (e.g. no gateway
 * traffic in the time range), that edge category is simply omitted.
 *
 * See SESSION-MEMORY-023.md Path A Phase 2 for the design rationale.
 */

interface InventoryRow {
    key: string;
    sid: string;
    kind: 'ip' | 'host';
}

interface RfcEdgeRow {
    src_sid: string;
    peer_ip: string;
    local_ip: string;
    call_count: string | number;
}

interface HanaEdgeRow {
    hana_host: string;
    client_ip: string;
    user: string;
    call_count: string | number;
}

interface HttpEdgeRow {
    dispatcher_host: string;
    clientip: string;
    call_count: string | number;
    error_count: string | number;
}

interface HanaTenantEdgeRow {
    hana_system: string;
    tenant_sid: string;
    call_count: string | number;
}

interface ActivityRowSpl {
    source_sid: string;
    partner: string;
    direction: 'client' | 'server';
    call_count: string | number;
}

interface CallsPerHourRow {
    _time: string;
    call_count: string | number;
}

export interface UseTopologyDataResult {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    activity: ActivityRow[];
    callsPerHour: number[];
    loading: boolean;
    /** Per-search errors. UI renders partial data + a banner if non-empty. */
    errors: { search: string; message: string }[];
    /** Diagnostic: how many endpoints in edges resolved to a SID vs stayed as raw IPs. */
    inventoryStatus: { totalEndpoints: number; resolved: number };
}

const num = (v: string | number | undefined): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
};

/** Tag is opportunistically derived from the SID prefix; SAP convention is
 * loose, but XC* / XH* / etc. give us a useful first cut for visual grouping.
 * HANA SIDs (`XH*` in this env) get the 'DB' tag so they render with a
 * database cylinder icon. */
const tagForSid = (sid: string): SystemTag => {
    if (sid.startsWith('XH')) return 'DB';      // HANA SIDs render as databases
    if (sid.startsWith('XC')) return 'ECC';
    if (sid.startsWith('BTP') || sid.startsWith('CPI')) return 'BTP';
    return 'ABAP';
};

/** Substring heuristic — does this id/label look like a database host?
 * Matches common DB product names and conventional naming patterns
 * (`*hdb*`, `*_db_*`, `*db<digits>` etc.). Used to override the partner
 * tag to 'DB' so the partner node renders with a cylinder icon. */
const looksLikeDatabase = (id: string): boolean => {
    const s = id.toLowerCase();
    if (/(?:^|[^a-z])(oracle|mssql|sqlserver|mysql|postgres|postgre|mariadb|mongo|redis|db2|sybase|hana|hdb)(?:[^a-z]|$)/.test(s)) return true;
    if (/(?:^|_)db(?:\d|_|$)/.test(s)) return true;
    if (/db\d+(?:[._-]|$)/.test(s)) return true;
    return false;
};

/** Heuristic: a known SID is "focused" only when it's the source of edges
 * AND has the most outbound calls. Top 2 by total volume become focused. */
const computeFocusedSids = (
    edges: { source: string; target: string; call: number; isSource: boolean }[],
): Set<string> => {
    const totals = new Map<string, number>();
    edges.forEach((e) => {
        if (e.isSource) {
            totals.set(e.source, (totals.get(e.source) ?? 0) + e.call);
        }
    });
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    return new Set(sorted.slice(0, 2).map(([sid]) => sid));
};

export const useTopologyData = (refreshNonce = 0): UseTopologyDataResult => {
    const inv = useSearch<InventoryRow>({ query: SEARCH_INVENTORY(), refreshNonce });
    const rfc = useSearch<RfcEdgeRow>({ query: SEARCH_RFC_EDGES(), refreshNonce });
    const hana = useSearch<HanaEdgeRow>({ query: SEARCH_HANA_EDGES(), refreshNonce });
    const http = useSearch<HttpEdgeRow>({ query: SEARCH_HTTP_EDGES(), refreshNonce });
    const hanaTenant = useSearch<HanaTenantEdgeRow>({ query: SEARCH_HANA_TENANT_EDGES(), refreshNonce });
    const activity = useSearch<ActivityRowSpl>({ query: SEARCH_ACTIVITY(), refreshNonce });
    const cph = useSearch<CallsPerHourRow>({ query: SEARCH_CALLS_PER_HOUR(), refreshNonce });

    return useMemo<UseTopologyDataResult>(() => {
        const loading = inv.loading || rfc.loading || hana.loading || http.loading || hanaTenant.loading || activity.loading || cph.loading;
        const errors: { search: string; message: string }[] = [];
        if (inv.error) errors.push({ search: 'inventory', message: inv.error.message });
        if (rfc.error) errors.push({ search: 'rfc', message: rfc.error.message });
        if (hana.error) errors.push({ search: 'hana', message: hana.error.message });
        if (http.error) errors.push({ search: 'http', message: http.error.message });
        if (hanaTenant.error) errors.push({ search: 'hana_tenant', message: hanaTenant.error.message });
        if (activity.error) errors.push({ search: 'activity', message: activity.error.message });
        if (cph.error) errors.push({ search: 'cph', message: cph.error.message });

        // Build the IP/host -> SID lookup
        const ipToSid = new Map<string, string>();
        const hostToSid = new Map<string, string>();
        (inv.results ?? []).forEach((r) => {
            if (r.kind === 'ip') ipToSid.set(r.key, r.sid);
            else hostToSid.set(r.key, r.sid);
        });

        // Resolve an endpoint (IP or host) -> SID-or-raw, plus is-known flag
        const resolve = (key: string | undefined | null): { id: string; sid: string | null } => {
            if (!key) return { id: 'unknown', sid: null };
            const sid = ipToSid.get(key) ?? hostToSid.get(key) ?? null;
            return { id: sid ?? key, sid };
        };

        // ---- Build edges from each source ----
        type RawEdge = { source: string; target: string; call: number; type: TopologyEdge['type']; isSource: boolean };
        const rawEdges: RawEdge[] = [];
        /** SIDs proven to BE a HANA system via the tracelogs tenant relationship.
         *  These nodes get the 'DB' tag override regardless of SID prefix. */
        const knownHanaSystems = new Set<string>();

        // RFC edges (gateway peer/local)
        (rfc.results ?? []).forEach((row) => {
            const src = row.src_sid;
            const tgt = resolve(row.peer_ip);
            const callCount = num(row.call_count);
            if (callCount === 0 || !tgt.id) return;
            // De-duplicate: if peer resolves to same SID as src, skip self-loop
            if (tgt.sid === src) return;
            rawEdges.push({ source: src, target: tgt.id, call: callCount, type: 'rfc', isSource: true });
        });

        // HANA cross-stack edges (HANA host as target SID-or-raw, client_ip as source)
        (hana.results ?? []).forEach((row) => {
            const tgtRes = resolve(row.hana_host);
            const tgtId = tgtRes.id ?? row.hana_host;
            const srcRes = resolve(row.client_ip);
            const callCount = num(row.call_count);
            if (callCount === 0) return;
            if (srcRes.id === tgtId) return;
            rawEdges.push({ source: srcRes.id, target: tgtId, call: callCount, type: 'web_service', isSource: false });
        });

        // HTTP inbound edges (web dispatcher)
        (http.results ?? []).forEach((row) => {
            const tgtRes = resolve(row.dispatcher_host);
            const tgtId = tgtRes.id ?? row.dispatcher_host;
            const srcRes = resolve(row.clientip);
            const callCount = num(row.call_count);
            if (callCount === 0) return;
            if (srcRes.id === tgtId) return;
            rawEdges.push({ source: srcRes.id, target: tgtId, call: callCount, type: 'odata', isSource: false });
        });

        // HANA tenant database hosting edges (sap:hana:tracelogs path)
        // Edge: tenant_sid -> hana_system (tenant runs ON the HANA system).
        // Direction 'client' because tenant is the consumer of HANA.
        // Track hana_system in knownHanaSystems so it gets the 'DB' tag.
        (hanaTenant.results ?? []).forEach((row) => {
            const callCount = num(row.call_count);
            if (callCount === 0) return;
            if (!row.hana_system || !row.tenant_sid) return;
            knownHanaSystems.add(row.hana_system);
            rawEdges.push({
                source: row.tenant_sid,
                target: row.hana_system,
                call: callCount,
                type: 'rfc',
                isSource: true,
            });
        });

        // Aggregate by (source, target, type)
        const edgeMap = new Map<string, RawEdge>();
        rawEdges.forEach((e) => {
            const k = `${e.source}|${e.target}|${e.type}`;
            const prev = edgeMap.get(k);
            if (prev) prev.call += e.call;
            else edgeMap.set(k, { ...e });
        });
        const aggEdges = Array.from(edgeMap.values());

        // Compute focused SIDs from outbound traffic
        const focused = computeFocusedSids(aggEdges);

        // Derive nodes from edge endpoints (union of all sources and targets)
        const nodeMap = new Map<string, { kind: NodeKind; sid: string | null; eventCount: number }>();
        aggEdges.forEach((e) => {
            [e.source, e.target].forEach((id) => {
                const existing = nodeMap.get(id);
                const isResolvedSid = ipToSid.get(id) === id || hostToSid.get(id) === id || /^[A-Z0-9]{3}$/.test(id);
                const kind: NodeKind = focused.has(id)
                    ? 'sid_focused'
                    : isResolvedSid
                      ? 'sid_secondary'
                      : 'partner';
                const inc = e.call;
                if (existing) {
                    existing.eventCount += inc;
                } else {
                    nodeMap.set(id, {
                        kind,
                        sid: isResolvedSid ? id : null,
                        eventCount: inc,
                    });
                }
            });
        });

        const nodes: TopologyNode[] = Array.from(nodeMap.entries()).map(([id, meta]) => {
            // Tag derivation pipeline (most-authoritative-first):
            //   1. knownHanaSystems set: any SID proven to be a HANA system via
            //      tracelog tenant relationships. Authoritative; overrides
            //      everything.
            //   2. SID-prefix heuristic (XH* -> DB, XC* -> ECC, etc.).
            //   3. Database substring heuristic on the id (for partner nodes
            //      with names like `oracle_db_prod`, `vhxsdxhqdb01`).
            let tag: SystemTag = meta.sid ? tagForSid(meta.sid) : 'EXT';
            if (knownHanaSystems.has(id)) {
                tag = 'DB';
            } else if (tag !== 'DB' && looksLikeDatabase(id)) {
                tag = 'DB';
            }
            return {
                id,
                label: id,
                kind: meta.kind,
                tag,
                eventCount: meta.eventCount,
                // Health % left undefined for v1 — needs separate availability
                // search to compute. Will surface in session 025.
            };
        });

        const edges: TopologyEdge[] = aggEdges.map((e, i) => ({
            id: `e-${i}-${e.source}-${e.target}-${e.type}`,
            source: e.source,
            target: e.target,
            type: e.type,
            direction: e.isSource ? 'client' : 'server',
            callCount: e.call,
        }));

        // ---- Activity table ----
        const activityRows: ActivityRow[] = (activity.results ?? []).map((row, i) => {
            const partnerRes = resolve(row.partner);
            return {
                id: `a-${i}`,
                sourceSid: row.source_sid,
                direction: row.direction,
                partner: partnerRes.id ?? row.partner,
                callCount: num(row.call_count),
            };
        });

        // ---- Calls/hour sparkline ----
        const callsPerHour = (cph.results ?? [])
            .map((row) => num(row.call_count))
            .slice(-24);

        // ---- Inventory status diagnostic ----
        let totalEndpoints = 0;
        let resolved = 0;
        aggEdges.forEach((e) => {
            [e.source, e.target].forEach((id) => {
                totalEndpoints += 1;
                if (/^[A-Z0-9]{3}$/.test(id) || hostToSid.has(id)) resolved += 1;
            });
        });

        return {
            nodes,
            edges,
            activity: activityRows,
            callsPerHour,
            loading,
            errors,
            inventoryStatus: { totalEndpoints, resolved },
        };
    }, [inv.results, inv.loading, inv.error, rfc.results, rfc.loading, rfc.error, hana.results, hana.loading, hana.error, http.results, http.loading, http.error, hanaTenant.results, hanaTenant.loading, hanaTenant.error, activity.results, activity.loading, activity.error, cph.results, cph.loading, cph.error]);
};
