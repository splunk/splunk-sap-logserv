import { createContext } from 'react';
import { NO_HOST_ALIASES, type HostAliasResolver } from '../../topology/nodeAlias';

/**
 * Build 400 - the customer's host names (Settings > Host Names) for the
 * topology's node components: the resolve function of state/HostAliasProvider,
 * which keeps its identity until the names change, so a Refresh that reads the
 * same names re-renders no node.
 *
 * A context, deliberately NOT a TopologyNode field - the IpEnrichmentContext
 * and HostCountContext rule: the names arrive after the first render, and
 * attaching them to the node objects would change the node-array identity that
 * TopologyGraph's layout effect keys on, running the layout again over the
 * user's viewport and dragged positions. Context reaches PartnerNode at render
 * time without touching the layout pipeline. Never written into a node label
 * either: topology/nodeAlias.ts says why.
 *
 * The provider (IntegrationTopology) passes useHostAlias().resolve, which
 * answers null until the table is read and after a failed read, so the squares
 * draw as before; outside a provider the default answers null too.
 *
 * Consumers: PartnerNode (the line under the label and the tooltip's Name row).
 * The side panels get the same resolver as a prop.
 */
export const NodeAliasContext = createContext<HostAliasResolver>(NO_HOST_ALIASES);

export default NodeAliasContext;
