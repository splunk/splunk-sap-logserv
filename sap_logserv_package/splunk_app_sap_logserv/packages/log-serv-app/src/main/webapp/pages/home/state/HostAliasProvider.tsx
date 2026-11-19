import React, { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalRefresh } from './GlobalRefreshProvider';
import { readAllHostAliases } from '../utils/hostAliasApi';
import {
    EMPTY_ALIAS_INDEX,
    HostAliasIndex,
    HostAliasRow,
    aliasDisplayNames,
    buildAliasIndex,
    formatAliasLabel,
    resolveAlias,
} from '../utils/hostAlias';

/**
 * HostAliasProvider - the customer's host names (Settings > Host Names) for
 * every view (App build 400).
 *
 * Mounted ONCE, in components/AppShell.tsx inside GlobalRefreshProvider: the
 * nav-bar Refresh reloads the table (outside that provider the refresh nonce
 * is a constant 0), and the dashboards, the pickers and the Settings page all
 * render below it. The editor calls reload() after a save.
 *
 * Display only. The names come from the browser's copy of the table and are
 * never put into a search, a filter, a sort, a click-through or a download:
 * those keep the raw value (utils/hostAlias.ts explains why).
 *
 * Two contexts:
 *  - the names, useHostAlias(): resolve, label, displayNames, rows,
 *    hasAliases, reload, version. Every DataTable, the per-host charts, the
 *    Host filters, the host lists and the topology read it. Its value is ONE
 *    object for as long as the names stay the same: a read that returns the
 *    same rows (in any order: they are sorted by key and compared as text)
 *    keeps it, and so does a failed read while no names are in use (every
 *    customer's default, or a failure after a failure). Only a read that
 *    returns other rows, or the first failed read while names are in use
 *    (it drops them all), gives a new object and re-renders those consumers.
 *  - the read's status, useHostAliasStatus(): loading, the last read's error
 *    and reload. Only the Settings > Host Names editor reads it. loading
 *    flips on every read (page load, Refresh, the topology's Refresh, every
 *    save), so it is kept out of the names' value.
 *
 * Starts with no names, and has none after a failed read: raw values always
 * render, a name is only ever shown where a view asks for one.
 *
 * Outside the provider (tests, isolated rendering) useHostAlias() answers
 * "no names": resolve -> null, label -> the raw value; useHostAliasStatus()
 * answers "not loading, no error".
 */

/* The base no-unused-vars rule is not TypeScript-aware: it reports the parameter
   names of the method signatures below. */
/* eslint-disable no-unused-vars */
export interface HostAliasContextValue {
    /** The alias of a raw host value, or null (utils/hostAlias.ts resolveAlias). */
    resolve(raw: unknown): string | null;
    /** "alias (raw)" for one-line lists such as dropdown options, the raw value when there is no alias. */
    label(raw: unknown): string;
    /** Names for raw values shown side by side (chart series, graph nodes): never two alike. */
    displayNames(raws: string[]): string[];
    /** The table as read (sanitized, sorted by key). At most MAX_ROWS stored rows
     *  are read; readAllHostAliases' `complete` tells whether that was all. */
    rows: HostAliasRow[];
    /** True when at least one name can show. */
    hasAliases: boolean;
    /** Read the table again (after a save). */
    reload(): void;
    /** Bumped each time the names change. */
    version: number;
}

/** The state of the provider's reads (useHostAliasStatus): for the editor only. */
export interface HostAliasStatus {
    /** True while a read is in flight. */
    loading: boolean;
    /** The last read's error, or null. */
    error: string | null;
    /** Read the table again (the same function as the names' reload). */
    reload(): void;
}
/* eslint-enable no-unused-vars */

const rawText = (raw: unknown): string => {
    if (typeof raw === 'string') {
        return raw;
    }
    return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
};

const NO_ALIASES: HostAliasContextValue = {
    resolve: () => null,
    label: (raw: unknown) => rawText(raw),
    displayNames: (raws: string[]) => raws.slice(),
    rows: [],
    hasAliases: false,
    reload: () => undefined,
    version: 0,
};

const NO_STATUS: HostAliasStatus = { loading: false, error: null, reload: () => undefined };

const HostAliasContext = createContext<HostAliasContextValue>(NO_ALIASES);
const HostAliasStatusContext = createContext<HostAliasStatus>(NO_STATUS);

interface Loaded {
    rows: HostAliasRow[];
    index: HostAliasIndex;
    version: number;
}

const EMPTY: Loaded = { rows: [], index: EMPTY_ALIAS_INDEX, version: 0 };

/** The signature of the empty table: the map in use when there are no names. */
const EMPTY_SIGNATURE = JSON.stringify(EMPTY.rows);

const compareText = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
};

/** By key, then by stored key (a row read under a key it does not derive, see
 *  sanitizeAliasRow). The KV Store returns rows in no fixed order, and the map
 *  must not be rebuilt (and every chart redrawn) when only the order changed. */
const byKey = (a: HostAliasRow, b: HostAliasRow): number => {
    const { _key: keyA } = a;
    const { _key: keyB } = b;
    return compareText(keyA, keyB) || compareText(a.stored_key || '', b.stored_key || '');
};

export const HostAliasProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { globalRefreshNonce } = useGlobalRefresh();
    const [reloadNonce, setReloadNonce] = useState<number>(0);
    const [loaded, setLoaded] = useState<Loaded>(EMPTY);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    /** The sorted rows of the map in use, as JSON: a read that gives the same
     *  text keeps the map. It starts as the empty table's and returns to it when
     *  a failed read drops the names, so the first read of an empty table (every
     *  customer's default) and a failed read with no names in use change nothing. */
    const signatureRef = useRef<string>(EMPTY_SIGNATURE);

    useEffect(() => {
        let cancelled = false;
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        setLoading(true);
        readAllHostAliases({ signal: controller ? controller.signal : undefined })
            .then((read) => {
                if (cancelled) {
                    return;
                }
                const rows = read.rows.slice().sort(byKey);
                const signature = JSON.stringify(rows);
                if (signature !== signatureRef.current) {
                    signatureRef.current = signature;
                    // No rows: the one empty map, so resolve and displayNames keep their identity.
                    const nextIndex = rows.length === 0 ? EMPTY_ALIAS_INDEX : buildAliasIndex(rows);
                    setLoaded((prev) => ({ rows, index: nextIndex, version: prev.version + 1 }));
                }
                setError(null);
                setLoading(false);
            })
            .catch((e: unknown) => {
                if (cancelled) {
                    return;
                }
                setError(e instanceof Error ? e.message : String(e));
                // Drop every name (raw values only until a read succeeds); with none in use, nothing changes.
                if (signatureRef.current !== EMPTY_SIGNATURE) {
                    signatureRef.current = EMPTY_SIGNATURE;
                    setLoaded((prev) => ({ rows: [], index: EMPTY_ALIAS_INDEX, version: prev.version + 1 }));
                }
                setLoading(false);
            });
        return () => {
            cancelled = true;
            if (controller) {
                controller.abort();
            }
        };
    }, [globalRefreshNonce, reloadNonce]);

    const { index } = loaded;
    const resolve = useCallback((raw: unknown): string | null => resolveAlias(index, raw), [index]);
    const label = useCallback((raw: unknown): string => formatAliasLabel(resolve(raw), rawText(raw)), [resolve]);
    const displayNames = useCallback((raws: string[]): string[] => aliasDisplayNames(raws, resolve), [resolve]);
    const reload = useCallback((): void => setReloadNonce((n) => n + 1), []);
    const hasAliases = index.size > 0;

    // Every input changes only when `loaded` does (a read with other rows, or the first failed read with names in use).
    const value = useMemo<HostAliasContextValue>(
        () => ({
            resolve,
            label,
            displayNames,
            rows: loaded.rows,
            hasAliases,
            reload,
            version: loaded.version,
        }),
        [resolve, label, displayNames, loaded.rows, hasAliases, reload, loaded.version],
    );

    const status = useMemo<HostAliasStatus>(() => ({ loading, error, reload }), [loading, error, reload]);

    return (
        <HostAliasStatusContext.Provider value={status}>
            <HostAliasContext.Provider value={value}>{children}</HostAliasContext.Provider>
        </HostAliasStatusContext.Provider>
    );
};

/** The host names in effect. Outside a HostAliasProvider: no names. */
export const useHostAlias = (): HostAliasContextValue => useContext(HostAliasContext);

/** The state of the provider's reads, for the Settings > Host Names editor only
 *  (the dashboards read useHostAlias, which a read in flight leaves untouched). */
export const useHostAliasStatus = (): HostAliasStatus => useContext(HostAliasStatusContext);
