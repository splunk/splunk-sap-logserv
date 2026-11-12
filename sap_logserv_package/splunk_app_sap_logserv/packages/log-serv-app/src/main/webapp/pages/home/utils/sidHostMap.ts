/**
 * sidHostMap — which hosts run which SAP system, from logserv_sid_hosts (build 395).
 *
 * The collection holds what each host logged about itself, one row per
 * (sid, host, role, tenant), with no judgement applied. The judgement lives here
 * so a later App build can change it without rebuilding the data:
 *
 *  - A value is a SAP system only if some row gives it a real role. SAP's
 *    monitoring lines also name supporting services through `--sid` (SBD is the
 *    cluster fencing check, GWC a gateway, SIN a certificate check); those are
 *    listed in NON_SYSTEM_ROLES. A deny list on purpose: an unknown role on a
 *    customer system shows a value that may not be a system, where an allow list
 *    would hide a real one.
 *  - A tenant links an application SID to its database: `--sid A44_A43` is HANA
 *    system A44 with tenant A43, so picking A43 also takes A44's hosts.
 *  - Standby and disaster recovery hosts belong to the SID; their role says what
 *    they are.
 *
 * Plain `.ts` so `bin/check-diagnostics.js` can test it.
 */

/** The sentinel the aggregate stores for "no role" and "no tenant". */
export const NONE_VALUE = '(none)';

/** Roles that name a supporting service or carry no meaning, never a SAP system. */
export const NON_SYSTEM_ROLES: readonly string[] = [
    'CGS_STB',
    'GWC',
    'HEC_HCC',
    'ICINGA_PROXY',
    'PACEMAKER_SBD',
    'SHA_CERT',
    'UNDEF',
];

export interface SidHostRow {
    sid?: unknown;
    host?: unknown;
    role?: unknown;
    tenant?: unknown;
}

export interface SidHost {
    host: string;
    /** Real roles on this host, sorted: `ABAP_CS`, `HANA_MASTER_P`, `D00`, ... */
    roles: string[];
    /** Set when the host is here as the database of the SID: its system's SID. */
    database?: string;
}

export interface SidEntry {
    sid: string;
    /** The system's own hosts, then its database's hosts. */
    hosts: SidHost[];
    /** The database systems linked by a tenant. */
    databases: string[];
}

export interface SidHostMap {
    /** Sorted by SID. */
    sids: SidEntry[];
    /** Every host of every system, for the Host filter when no SID is selected. */
    hosts: SidHost[];
}

const text = (v: unknown): string => {
    const s = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    return s === NONE_VALUE ? '' : s;
};

const byName = (a: string, b: string): number => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
};

/** A SAP system ID: a letter, then two letters or digits. The aggregate holds a
 *  sid to this; a tenant comes from a database name, which can be anything, and
 *  a `*` in one would widen a filter to every row. */
export const isSidName = (s: string): boolean => /^[A-Z][A-Z0-9]{2}$/.test(s);

export const EMPTY_SID_HOST_MAP: SidHostMap = { sids: [], hosts: [] };

export const buildSidHostMap = (rows: readonly SidHostRow[]): SidHostMap => {
    // sid -> host -> roles. A row with no role is real evidence (a log path with
    // no instance directory); a row with only non-system roles is not.
    const own = new Map<string, Map<string, Set<string>>>();
    // tenant -> the database systems that hold it.
    const links = new Map<string, Set<string>>();

    rows.forEach((r) => {
        const sid = text(r.sid);
        const host = text(r.host);
        if (!isSidName(sid) || !host) return;
        const role = text(r.role);
        const tenant = text(r.tenant);
        const counts = NON_SYSTEM_ROLES.indexOf(role) === -1;
        if (counts) {
            if (!own.has(sid)) own.set(sid, new Map());
            const hosts = own.get(sid) as Map<string, Set<string>>;
            if (!hosts.has(host)) hosts.set(host, new Set());
            if (role) (hosts.get(host) as Set<string>).add(role);
        }
        if (counts && isSidName(tenant) && tenant !== sid) {
            if (!links.has(tenant)) links.set(tenant, new Set());
            (links.get(tenant) as Set<string>).add(sid);
        }
    });

    const ownHosts = (sid: string, database?: string): SidHost[] => {
        const hosts = own.get(sid);
        if (!hosts) return [];
        return Array.from(hosts.keys())
            .sort(byName)
            .map((host) => {
                const entry: SidHost = {
                    host,
                    roles: Array.from(hosts.get(host) as Set<string>).sort(byName),
                };
                if (database) entry.database = database;
                return entry;
            });
    };

    const sidNames = new Set<string>(own.keys());
    // A tenant with no hosts of its own is still a system someone can pick: its
    // database's hosts are what the logs know about it.
    links.forEach((_v, tenant) => sidNames.add(tenant));

    const sids: SidEntry[] = Array.from(sidNames)
        .sort(byName)
        .map((sid) => {
            const databases = Array.from(links.get(sid) ?? []).sort(byName);
            const seen = new Set<string>();
            const hosts: SidHost[] = [];
            ownHosts(sid).concat(...databases.map((d) => ownHosts(d, d))).forEach((h) => {
                if (seen.has(h.host)) return;
                seen.add(h.host);
                hosts.push(h);
            });
            return { sid, hosts, databases };
        })
        .filter((e) => e.hosts.length > 0);

    const merged = new Map<string, Set<string>>();
    own.forEach((hosts) => {
        hosts.forEach((roles, host) => {
            if (!merged.has(host)) merged.set(host, new Set());
            roles.forEach((role) => (merged.get(host) as Set<string>).add(role));
        });
    });
    const allHosts: SidHost[] = Array.from(merged.keys())
        .sort(byName)
        .map((host) => ({ host, roles: Array.from(merged.get(host) as Set<string>).sort(byName) }));

    return { sids, hosts: allHosts };
};

export const findSid = (map: SidHostMap, sid: string | null): SidEntry | null =>
    (sid ? map.sids.find((e) => e.sid === sid) ?? null : null);

/** The hosts and SIDs one selected SID stands for. */
export const scopeOf = (entry: SidEntry): { scopeHosts: string[]; scopeSids: string[] } => ({
    scopeHosts: entry.hosts.map((h) => h.host),
    scopeSids: [entry.sid].concat(entry.databases),
});

/** What the Host filter shows beside a host: `database A44 · HANA_MASTER_P`. */
export const describeHost = (h: SidHost): string => {
    const roles = h.roles.join(', ');
    if (h.database) return roles ? `database ${h.database} · ${roles}` : `database ${h.database}`;
    return roles;
};
