import { createContext } from 'react';
import type { IpEnrichmentEntry } from '../../topology/enrichment';

/**
 * Build 329 / session 112 — the per-IP hostname/user enrichment index from
 * the flat logserv_topology_ip_enrichment collection, keyed by the node's
 * LABEL (which for the target squares IS the IP; hostname-labeled nodes
 * simply never hit the IP-keyed map).
 *
 * A context, deliberately NOT a TopologyNode field — the HostCountContext
 * precedent (session-110 review HIGH #1): attaching a late-arriving fetch
 * result to the node objects would put it into the node-array identity that
 * TopologyGraph's layout effect keys on, re-running d3-force and clobbering
 * the user's restored viewport/drag positions after every load. Context
 * reaches PartnerNode at render time without touching the layout pipeline.
 *
 * The provider (IntegrationTopology) supplies an EMPTY map until the first
 * fetch resolves — the enrichment lines simply don't render yet (absence is
 * not a claim). The index is NOT picker-bound (ratified latest-known
 * semantics), so there is no window-staleness guard to apply; the nav-bar
 * Refresh nonce re-fetches it.
 *
 * Consumers: PartnerNode (hostname + user lines under the IP label). The
 * sidebar gets the same index via an explicit prop.
 */
export const IpEnrichmentContext = createContext<ReadonlyMap<string, IpEnrichmentEntry>>(new Map());

export default IpEnrichmentContext;
