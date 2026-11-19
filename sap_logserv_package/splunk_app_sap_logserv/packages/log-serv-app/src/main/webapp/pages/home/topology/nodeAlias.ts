/**
 * Host names (Settings > Host Names) on the Environment Topology (App build 400).
 *
 * The customer's name for a host shows NEXT TO the raw value, on screen only:
 *  - a node's LABEL stays the raw value. refineTag classifies a partner's
 *    database vendor from its label (topology/types.ts detectDbVendor), the
 *    label is the scope of every side-panel read (topology/searches.ts) and the
 *    key of the IP enrichment index, so a name written into it could change a
 *    node's tag or scope a read to the wrong rows;
 *  - the name never enters the node arrays. TopologyGraph runs the layout again
 *    when they change, so a name that arrives after the first render would run
 *    d3-force or ELK again over the user's viewport (the HostCountContext and
 *    IpEnrichmentContext rule). The node components read it from
 *    NodeAliasContext and the side panels from a prop, at render time;
 *  - node ids, edges, saved layouts, the KV scope keys and every search keep
 *    the raw value.
 *
 * Which values get a name: the labels of remote partners (an IP address, a host
 * name or a SAP Router host), the hosts of the Hosts tab and of Calls by host,
 * and the app-server addresses of an RFC edge. Not SID circles and not HANA
 * tenant circles: their label is a SID, which a short host name could otherwise
 * match (a SID "XCP" against a host entry "xcp"). The IP enrichment host name
 * gets no name of its own: it is evidence about an address, and naming it would
 * give the address a name the table does not give it (an IP address matches
 * only its own entry, utils/hostAlias.ts rule (a)).
 *
 * The line under a partner square's label is SHARED: the node's name takes the
 * line the IP enrichment host name uses, and that host name moves to the hover
 * tooltip. So a square never has more lines than an IP square already reserves
 * (a square labelled with a host name, which the IP-keyed enrichment never
 * matches, gains that one line when it has a name), and the ELK partner box
 * (95 x 175 in layoutLayered.ts and layoutMrtree.ts) and the collide radius
 * (layout.ts) stay as they are.
 *
 * GATE-SAFE MODULE: no @splunk or React imports, nothing executes at import
 * time - utils/topologyTypes.consistency-test.ts loads it directly.
 */

/** The name of a raw host value from Settings > Host Names, or null
 *  (state/HostAliasProvider's resolve: utils/hostAlias.ts resolveAlias over the
 *  table in effect). */
// eslint-disable-next-line no-unused-vars -- a parameter name in a function type (the base rule is not TypeScript-aware)
export type HostAliasResolver = (raw: unknown) => string | null;

/** The resolver where no names are provided: none. */
export const NO_HOST_ALIASES: HostAliasResolver = () => null;

/** The fields of a topology node these rules read. */
export interface AliasableNode {
    label: string;
    kind: string;
    tag: string;
}

/** True for a node whose label is a host value: a remote partner other than a
 *  HANA tenant. */
export const isHostLabelNode = (node: AliasableNode | null | undefined): boolean =>
    node !== null && node !== undefined && node.kind === 'partner' && node.tag !== 'TENANT';

/** The name of a node, or null: only a node whose label is a host value gets one. */
export const nodeAlias = (node: AliasableNode | null | undefined, resolve: HostAliasResolver): string | null =>
    (node !== null && node !== undefined && isHostLabelNode(node) ? resolve(node.label) : null);

/** The labels that only host-labelled nodes carry, for a surface that holds a
 *  label and not a node (Live Activity). A label that a SID or tenant node also
 *  carries is left out, so it never gets a name (suppress over guess). */
export const hostLabelSet = (nodes: ReadonlyArray<AliasableNode>): ReadonlySet<string> => {
    const hosts = new Set<string>();
    const others = new Set<string>();
    nodes.forEach((n) => {
        if (isHostLabelNode(n)) {
            hosts.add(n.label);
        } else {
            others.add(n.label);
        }
    });
    others.forEach((label) => hosts.delete(label));
    return hosts;
};

/** What a partner square shows under its label. */
export interface PartnerNameSlot {
    /** The one line under the label: the node's name, else the IP enrichment
     *  host name, else none. */
    line: { text: string; isAlias: boolean } | null;
    /** The enrichment host name that the node's name took the line from, for
     *  the hover tooltip; null when it is on the line or there is none. */
    tooltipHostname: string | null;
}

/** The shared line: the name wins it, and the enrichment host name it displaces
 *  moves to the tooltip. Never more lines than an IP square already reserves. */
export const partnerNameSlot = (alias: string | null, enrichHostname: string | null | undefined): PartnerNameSlot => {
    const hostname = typeof enrichHostname === 'string' && enrichHostname.length > 0 ? enrichHostname : null;
    if (alias !== null && alias.length > 0) {
        return { line: { text: alias, isAlias: true }, tooltipHostname: hostname };
    }
    if (hostname !== null) {
        return { line: { text: hostname, isAlias: false }, tooltipHostname: null };
    }
    return { line: null, tooltipHostname: null };
};
