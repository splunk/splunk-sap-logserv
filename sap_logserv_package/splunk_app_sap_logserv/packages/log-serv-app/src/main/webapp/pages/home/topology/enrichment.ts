/**
 * IP-node enrichment — hostname + user names for the topology view's IP
 * partner squares (session 112 / build 329).
 *
 * Data source: the FLAT KV Store collection `logserv_topology_ip_enrichment`
 * (one row per (ip, evidence_source)), populated DAILY by
 * [logserv_topology_enrichment_aggregate] from four same-event log sources:
 * HANA audit (client_ip + audit_hostname + executing_user), Windows 4624
 * logons (IpAddress + WorkstationName + TargetUserName, with an in-SPL
 * self-reference guard), sapstartsrv auth lines (auth_user + remote_address)
 * and sshd session lines. Gateway peer_ip is deliberately NOT a source —
 * peer_ip and gw_remote_host never co-occur on one event, and the ratified
 * session-112 decision is suppress-over-guess.
 *
 * The stored rows carry the RAW hostname forms, UN-guarded. The ambiguity
 * guards live HERE, where the whole-index view exists:
 *   1. Per-IP uniqueness — a hostname resolves only when the IP's candidate
 *      set collapses to exactly ONE normalized name (lowercased first DNS
 *      label, which merges the observed short-vs-FQDN split for the same
 *      machine).
 *   2. Crowd guard — the normalized name must be claimed by at most
 *      ENRICHMENT_HOSTNAME_CROWD_MAX distinct IPs across the index. A real
 *      host has one or two addresses; a name claimed by a crowd (the demo
 *      dataset's hec53v052422 constant, claimed by ~30 IPs) is bogus for
 *      most or all of its claimants, so it renders for NONE of them —
 *      conservative per the ratified decision, accepted collateral on any
 *      single legitimate claimant in the crowd.
 *
 * Latest-known semantics (ratified): the index is NOT bound to the time
 * picker. The aggregate recomputes a rolling 30-day window daily; rows for
 * IPs unseen longer keep their last values until the 365-day retention
 * trims them. `lastSeen` is surfaced so the Overview can say so.
 *
 * DELIVERY IS VIA IpEnrichmentContext + a sidebar prop, NEVER the node
 * arrays — attaching a late-arriving fetch result to the nodes would re-fire
 * TopologyGraph's layout effect and clobber the user's viewport (session-110
 * review HIGH #1 / the HostCountContext precedent). The node LABEL stays the
 * IP: refineTag reads labels, so writing a hostname into the label could
 * flip a node's DB-vendor classification (session-107 trap). Enrichment is
 * display-only — it never feeds a diagnostic verdict and is never spliced
 * into SPL.
 *
 * GATE-SAFE MODULE: no @splunk imports, nothing executes at import time —
 * topologyEnrichment.consistency-test.ts loads the pure functions directly.
 */

/** Raw KV row shape as returned by the collection endpoint. Multivalue
 *  fields round-trip as arrays when they held 2+ values and as plain
 *  strings when they held one (the session-110 `instances` behavior). */
export interface IpEnrichmentRow {
    ip?: unknown;
    evidence_source?: unknown;
    hostnames?: unknown;
    users?: unknown;
    user_count?: unknown;
    event_count?: unknown;
    first_seen?: unknown;
    last_seen?: unknown;
}

export interface EnrichedUser {
    /** Display form — the first form seen for this (case-insensitive) name. */
    name: string;
    /** Evidence sources that reported the name, in SOURCE_ORDER. */
    sources: string[];
}

export interface IpEnrichmentEntry {
    ip: string;
    /** Resolved hostname display form (the shortest raw form — the bare
     *  machine name rather than the FQDN, it has to fit under a node), or
     *  null when nothing resolved (no evidence OR suppressed as ambiguous). */
    hostname: string | null;
    /** Evidence sources behind the resolved hostname (empty when null). */
    hostnameSources: string[];
    /** All distinct users across sources, name-sorted. */
    users: EnrichedUser[];
    userCount: number;
    /** Max last_seen epoch (seconds) across the IP's evidence rows. */
    lastSeen: number;
}

/** A normalized hostname claimed by MORE distinct IPs than this is
 *  suppressed everywhere (guard 2 above). 2 = the multi-NIC allowance. */
export const ENRICHMENT_HOSTNAME_CROWD_MAX = 2;

/** Canonical evidence-source ordering for display. */
export const ENRICHMENT_SOURCE_ORDER: string[] = ['hana_audit', 'windows', 'sapstartsrv', 'ssh'];

/** Human labels for the Overview rows' provenance notes. */
export const ENRICHMENT_SOURCE_LABELS: Record<string, string> = {
    hana_audit: 'HANA audit',
    windows: 'Windows logons',
    sapstartsrv: 'SAP start service',
    ssh: 'SSH sessions',
};

export const enrichmentSourceLabel = (source: string): string =>
    ENRICHMENT_SOURCE_LABELS[source] ?? source;

/* ------------------------------------------------------------------ */
/* Sanitize-on-read. The collection is world-writable (the standard    */
/* topology ACL), so every string that reaches the DOM is length-      */
/* capped and control-character-checked here. React escapes markup     */
/* anyway; the angle-bracket check is belt-and-suspenders. NOTE: the   */
/* control check uses charCodeAt on purpose — no escape sequences.     */
/* ------------------------------------------------------------------ */

const hasControlChars = (s: string): boolean => {
    for (let i = 0; i < s.length; i += 1) {
        if (s.charCodeAt(i) < 32) return true;
    }
    return false;
};

const saneValue = (s: string, maxLen: number): boolean =>
    s.length > 0
    && s.length <= maxLen
    && !hasControlChars(s)
    && s.indexOf('<') === -1
    && s.indexOf('>') === -1;

/** KV multivalue fields arrive as string | string[] | absent. */
const toStringArray = (v: unknown): string[] => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return typeof v === 'string' ? [v] : [];
};

const toEpoch = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Lowercased first DNS label: "HEC53V052470.sin.hec.xsd-vlab.com" and
 *  "hec53v052470" normalize to the same candidate. */
export const normalizeHostname = (raw: string): string => {
    const trimmed = raw.trim().toLowerCase();
    const dot = trimmed.indexOf('.');
    return dot === -1 ? trimmed : trimmed.slice(0, dot);
};

const sortSources = (sources: Set<string>): string[] => {
    const known = ENRICHMENT_SOURCE_ORDER.filter((s) => sources.has(s));
    const unknown = Array.from(sources)
        .filter((s) => ENRICHMENT_SOURCE_ORDER.indexOf(s) === -1)
        .sort();
    return known.concat(unknown);
};

interface IpAccumulator {
    /** lowercased name -> display form + sources. */
    users: Map<string, { name: string; sources: Set<string> }>;
    /** normalized hostname -> raw forms + sources. */
    candidates: Map<string, { forms: Set<string>; sources: Set<string> }>;
    lastSeen: number;
}

/**
 * Pure merge of the collection rows into a per-IP index. Applies both
 * ambiguity guards. IPs whose evidence resolves to nothing (no users AND no
 * resolved hostname) get NO entry — absence is the suppressed state.
 */
export const buildEnrichmentIndex = (
    rows: IpEnrichmentRow[],
): ReadonlyMap<string, IpEnrichmentEntry> => {
    const byIp = new Map<string, IpAccumulator>();

    rows.forEach((row) => {
        const ip = typeof row.ip === 'string' ? row.ip.trim() : '';
        const source = typeof row.evidence_source === 'string' ? row.evidence_source.trim() : '';
        if (!saneValue(ip, 64) || !saneValue(source, 32)) return;

        let acc = byIp.get(ip);
        if (!acc) {
            acc = { users: new Map(), candidates: new Map(), lastSeen: 0 };
            byIp.set(ip, acc);
        }

        toStringArray(row.users).forEach((u) => {
            const name = u.trim();
            if (!saneValue(name, 128)) return;
            const key = name.toLowerCase();
            const existing = acc!.users.get(key);
            if (existing) existing.sources.add(source);
            else acc!.users.set(key, { name, sources: new Set([source]) });
        });

        toStringArray(row.hostnames).forEach((h) => {
            const raw = h.trim();
            if (!saneValue(raw, 253)) return;
            const norm = normalizeHostname(raw);
            if (!norm) return;
            const existing = acc!.candidates.get(norm);
            if (existing) {
                existing.forms.add(raw);
                existing.sources.add(source);
            } else {
                acc!.candidates.set(norm, { forms: new Set([raw]), sources: new Set([source]) });
            }
        });

        acc.lastSeen = Math.max(acc.lastSeen, toEpoch(row.last_seen));
    });

    /* Guard 2 input: how many distinct IPs claim each normalized name.
     * ALL candidates count — an IP whose own set is ambiguous still claims
     * its names (counting only resolved claims would let a crowd hide
     * behind its own ambiguity). */
    const claimCounts = new Map<string, number>();
    byIp.forEach((acc) => {
        acc.candidates.forEach((_cand, norm) => {
            claimCounts.set(norm, (claimCounts.get(norm) ?? 0) + 1);
        });
    });

    const index = new Map<string, IpEnrichmentEntry>();
    byIp.forEach((acc, ip) => {
        let hostname: string | null = null;
        let hostnameSources: string[] = [];
        if (acc.candidates.size === 1) {
            const norm = acc.candidates.keys().next().value as string;
            const cand = acc.candidates.get(norm)!;
            if ((claimCounts.get(norm) ?? 0) <= ENRICHMENT_HOSTNAME_CROWD_MAX) {
                /* Display the shortest raw form (bare name over FQDN);
                 * lexical tie-break keeps the pick deterministic. */
                hostname = Array.from(cand.forms).sort(
                    (a, b) => a.length - b.length || a.localeCompare(b),
                )[0];
                hostnameSources = sortSources(cand.sources);
            }
        }

        const users = Array.from(acc.users.values())
            .map((u) => ({ name: u.name, sources: sortSources(u.sources) }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!hostname && users.length === 0) return;
        index.set(ip, {
            ip,
            hostname,
            hostnameSources,
            users,
            userCount: users.length,
            lastSeen: acc.lastSeen,
        });
    });

    return index;
};

/**
 * The node-label user line (ratified session-112 decision 1): exactly one
 * distinct user -> the name; several -> a count ("7 users"); none -> null.
 * The Overview panel lists every user regardless.
 */
export const nodeUserLine = (entry: IpEnrichmentEntry): string | null => {
    if (entry.userCount === 1) return entry.users[0].name;
    if (entry.userCount > 1) return `${entry.userCount} users`;
    return null;
};

/**
 * The Overview "Users" row groups by SOURCE (ratified decision 2:
 * source-labeled). A user seen from two sources appears under both groups —
 * duplication over ambiguity. Group order = ENRICHMENT_SOURCE_ORDER, names
 * name-sorted within each group (they arrive sorted from the index).
 */
export const groupUsersBySource = (
    entry: IpEnrichmentEntry,
): Array<{ source: string; label: string; names: string[] }> => {
    const seen: string[] = [];
    entry.users.forEach((u) => {
        u.sources.forEach((s) => {
            if (seen.indexOf(s) === -1) seen.push(s);
        });
    });
    const ordered = ENRICHMENT_SOURCE_ORDER.filter((s) => seen.indexOf(s) !== -1)
        .concat(seen.filter((s) => ENRICHMENT_SOURCE_ORDER.indexOf(s) === -1).sort());
    return ordered
        .map((source) => ({
            source,
            label: enrichmentSourceLabel(source),
            names: entry.users.filter((u) => u.sources.indexOf(source) !== -1).map((u) => u.name),
        }))
        .filter((g) => g.names.length > 0);
};

/* ------------------------------------------------------------------ */
/* Fetch. Same REST shape as the other topology collection reads       */
/* (useTopologyData fetchKvAllRows): the Splunk Web `__raw` proxy      */
/* prefix is mandatory (session-035 sticky #3).                        */
/* ------------------------------------------------------------------ */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
export const ENRICHMENT_COLLECTION = 'logserv_topology_ip_enrichment';
const KV_URL = `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}`
    + `/storage/collections/data/${ENRICHMENT_COLLECTION}?limit=0&output_mode=json`;

export const fetchIpEnrichmentRows = async (): Promise<IpEnrichmentRow[]> => {
    const res = await fetch(KV_URL, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`IP enrichment fetch failed: ${res.status} ${res.statusText}`);
    }
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as IpEnrichmentRow[]) : [];
};
