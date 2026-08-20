import { createContext } from 'react';

/**
 * Build 325 / session 110 (plan item D1) — the per-node distinct-host counts
 * from the bulk SEARCH_NODE_HOST_COUNTS read, keyed by the node's canonical
 * LABEL (the read's `scope` — the same label-scoping the Hosts tab uses).
 *
 * A context, deliberately NOT a TopologyNode field: attaching the count to
 * the node objects would put the late-arriving SPL job into the node-array
 * identity that TopologyGraph's layout effect keys on — re-running d3-force
 * and clobbering the user's restored viewport/drag positions seconds after
 * every load, picker change and Refresh tick (review fold, session 110).
 * Context reaches the node components (SidNode reads it at render time for
 * the hover tooltip) without touching the layout pipeline at all.
 *
 * The provider (IntegrationTopology) supplies an EMPTY map while the bulk
 * read is in flight, so a window change never shows the previous window's
 * counts as current-window facts — the tooltip row simply disappears until
 * fresh counts land (absence is not a claim).
 *
 * Consumers: SidNode (SID nodes only — tenant-database nodes share their
 * label with the application SID they back, so a tooltip "Hosts" row there
 * would present that system's hosts as the tenant's with no room to hedge;
 * PartnerNode therefore does NOT consume this. The sidebar's facts row DOES
 * cover tenants, with the collision hedge a sentence can carry).
 */
export const HostCountContext = createContext<ReadonlyMap<string, number>>(new Map());

export default HostCountContext;
