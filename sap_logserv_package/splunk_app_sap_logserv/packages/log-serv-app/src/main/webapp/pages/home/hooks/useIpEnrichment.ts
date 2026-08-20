import { useEffect, useState } from 'react';
import {
    buildEnrichmentIndex,
    fetchIpEnrichmentRows,
    type IpEnrichmentEntry,
} from '../topology/enrichment';

const EMPTY_INDEX: ReadonlyMap<string, IpEnrichmentEntry> = new Map();

/**
 * Build 329 / session 112 — fetch + merge the IP enrichment collection.
 *
 * Fires on mount and again when the nav-bar/topology Refresh nonce bumps.
 * NOT picker-dependent: the index carries "latest known" mappings (ratified
 * session-112 decision 4), so a time-range change neither refetches nor
 * invalidates it. The initial state is an EMPTY map (nothing renders until
 * evidence arrives); a re-fetch keeps the previous index until the new one
 * lands (the data is not windowed, so it cannot go stale the way the
 * host-count map could — contrast the session-110 loading guard). Fetch
 * failure degrades to the empty map: the lines just don't render.
 */
export const useIpEnrichment = (
    refreshNonce: number,
): ReadonlyMap<string, IpEnrichmentEntry> => {
    const [index, setIndex] = useState<ReadonlyMap<string, IpEnrichmentEntry>>(EMPTY_INDEX);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const rows = await fetchIpEnrichmentRows();
                if (!cancelled) setIndex(buildEnrichmentIndex(rows));
            } catch {
                if (!cancelled) setIndex(EMPTY_INDEX);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [refreshNonce]);

    return index;
};

export default useIpEnrichment;
