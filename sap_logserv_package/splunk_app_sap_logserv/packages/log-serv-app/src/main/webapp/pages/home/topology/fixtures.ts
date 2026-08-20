import type { TopologyNode, TopologyEdge, ActivityRow } from './types';

/**
 * Static fixture data for the Phase-1 prototype. Replaced in session 024 by
 * SPL aggregations against the live indexed events. Kept here so the
 * prototype renders deterministically + offline.
 *
 * SID names re-use the remapped sample-log SIDs (see CLAUDE.md "Sample
 * Logs for Demo/Testing"): XCP/XCQ/XCD/XCR/XCS/XCM (ABAP), XCJ/XHQ/XHD/XHR/XHX
 * (HANA-fronted S/4 stacks).
 */

export const FIXTURE_NODES: TopologyNode[] = [
    // Focused SIDs — center, big red rings
    { id: 'XCP', label: 'XCP', kind: 'sid_focused', tag: 'ECC', eventCount: 18_953_968, healthPct: 88 },
    { id: 'XHQ', label: 'XHQ', kind: 'sid_focused', tag: 'S4',  eventCount: 7_176_241,  healthPct: 94 },

    // Secondary internal SIDs — medium white circles
    { id: 'XCD', label: 'XCD', kind: 'sid_secondary', tag: 'ECC', eventCount: 3_329_493 },
    { id: 'XCR', label: 'XCR', kind: 'sid_secondary', tag: 'ECC', eventCount: 1_209_201 },
    { id: 'XCS', label: 'XCS', kind: 'sid_secondary', tag: 'BTP', eventCount: 941_870 },
    { id: 'XHD', label: 'XHD', kind: 'sid_secondary', tag: 'S4',  eventCount: 642_117 },

    // Partner / remote nodes — small gray rounded squares
    { id: 'partner-host-w16xcp00', label: 'w16s24xcp_XCP_00', kind: 'partner', tag: 'EXT', eventCount: 6_515_542 },
    { id: 'partner-host-w16xhq00', label: 'w16s24xhq_XHQ_00', kind: 'partner', tag: 'EXT', eventCount: 2_277_288 },
    { id: 'partner-oracle',       label: 'oracle_db_prod',     kind: 'partner', tag: 'EXT', eventCount: 1_840_400 },
    { id: 'partner-mssql',        label: 'mssql_warehouse',    kind: 'partner', tag: 'EXT', eventCount: 612_103 },
    { id: 'partner-btp',          label: 'sap_btp_eu10',       kind: 'partner', tag: 'BTP', eventCount: 408_911 },
    { id: 'partner-cpi',          label: 'cpi_runtime_prod',   kind: 'partner', tag: 'BTP', eventCount: 360_447 },
    { id: 'partner-salesforce',   label: 'salesforce_api',     kind: 'partner', tag: 'EXT', eventCount: 297_140 },
    { id: 'partner-aad',          label: 'azure_ad_sso',       kind: 'partner', tag: 'EXT', eventCount: 188_762 },
    { id: 'partner-ariba',        label: 'sap_ariba_proc',     kind: 'partner', tag: 'EXT', eventCount: 154_009 },
    { id: 'partner-success',      label: 'successfactors_hcm', kind: 'partner', tag: 'EXT', eventCount: 116_088 },
    { id: 'partner-fiori-ext',    label: 'ext_fiori_gateway',  kind: 'partner', tag: 'BTP', eventCount: 92_340 },
    { id: 'partner-mqseries',     label: 'ibm_mq_bridge',      kind: 'partner', tag: 'EXT', eventCount: 38_122 },
];

export const FIXTURE_EDGES: TopologyEdge[] = [
    // XCP outbound (client) — RFC heavy hitters
    { id: 'e-xcp-host00-out', source: 'XCP', target: 'partner-host-w16xcp00', type: 'rfc',  direction: 'client', callCount: 6_515_542, process: 'o2c_invoice', bucketIds: [], activity: [] },
    { id: 'e-xcp-oracle',     source: 'XCP', target: 'partner-oracle',         type: 'rfc',  direction: 'client', callCount: 1_840_400, process: 'mixed', bucketIds: [], activity: [] },
    { id: 'e-xcp-mssql',      source: 'XCP', target: 'partner-mssql',          type: 'odata', direction: 'client', callCount: 612_103, process: 'untagged', bucketIds: [], activity: [] },
    { id: 'e-xcp-cpi',        source: 'XCP', target: 'partner-cpi',            type: 'btp_iflow', direction: 'client', callCount: 360_447, process: 'o2c_order', bucketIds: [], activity: [] },
    { id: 'e-xcp-aad',        source: 'XCP', target: 'partner-aad',            type: 'web_service', direction: 'client', callCount: 188_762, process: 'untagged', bucketIds: [], activity: [] },

    // XCP inbound (server) — RFC server side
    { id: 'e-xcp-host00-in',  source: 'partner-host-w16xcp00', target: 'XCP', type: 'rfc', direction: 'server', callCount: 2_277_288, process: 'o2c_delivery', bucketIds: [], activity: [] },
    { id: 'e-xcp-fiori-in',   source: 'partner-fiori-ext',     target: 'XCP', type: 'odata', direction: 'server', callCount: 92_340, process: 'o2c_order', bucketIds: [], activity: [] },

    // XCP ↔ secondary SID
    { id: 'e-xcp-xcd',        source: 'XCP', target: 'XCD', type: 'rfc',  direction: 'bidi', callCount: 940_212, process: 'mixed', bucketIds: [], activity: [] },
    { id: 'e-xcp-xcr',        source: 'XCP', target: 'XCR', type: 'qrfc', direction: 'client', callCount: 612_804, process: 'o2c_invoice', bucketIds: [], activity: [] },
    { id: 'e-xcp-xcs',        source: 'XCP', target: 'XCS', type: 'idoc', direction: 'client', callCount: 481_220, process: 'o2c_payment', bucketIds: [], activity: [] },

    // XHQ outbound
    { id: 'e-xhq-host00',     source: 'XHQ', target: 'partner-host-w16xhq00', type: 'rfc',  direction: 'client', callCount: 2_277_288, process: 'o2c_invoice', bucketIds: [], activity: [] },
    { id: 'e-xhq-btp',        source: 'XHQ', target: 'partner-btp',           type: 'btp_iflow', direction: 'client', callCount: 408_911, process: 'o2c_order', bucketIds: [], activity: [] },
    { id: 'e-xhq-salesforce', source: 'XHQ', target: 'partner-salesforce',    type: 'web_service', direction: 'client', callCount: 297_140, process: 'mixed', bucketIds: [], activity: [] },
    { id: 'e-xhq-success',    source: 'XHQ', target: 'partner-success',       type: 'odata', direction: 'client', callCount: 116_088, process: 'untagged', bucketIds: [], activity: [] },
    { id: 'e-xhq-ariba',      source: 'XHQ', target: 'partner-ariba',         type: 'web_service', direction: 'client', callCount: 154_009, process: 'o2c_order', bucketIds: [], activity: [] },

    // XHQ ↔ secondary
    { id: 'e-xhq-xhd',        source: 'XHQ', target: 'XHD', type: 'trfc', direction: 'bidi', callCount: 642_117, process: 'mixed', bucketIds: [], activity: [] },
    { id: 'e-xhq-xcd',        source: 'XHQ', target: 'XCD', type: 'idoc', direction: 'client', callCount: 294_528, process: 'o2c_invoice', bucketIds: [], activity: [] },

    // XCD outbound (cross-stack)
    { id: 'e-xcd-mq',         source: 'XCD', target: 'partner-mqseries',      type: 'web_service', direction: 'client', callCount: 38_122, process: 'untagged', bucketIds: [], activity: [] },

    // XCS BTP iFlow chain
    { id: 'e-xcs-cpi',        source: 'XCS', target: 'partner-cpi',           type: 'btp_iflow', direction: 'bidi', callCount: 167_433, process: 'o2c_order', bucketIds: [], activity: [] },
    { id: 'e-xcs-btp',        source: 'XCS', target: 'partner-btp',           type: 'btp_iflow', direction: 'client', callCount: 89_044, process: 'o2c_order', bucketIds: [], activity: [] },

    // XCR background
    { id: 'e-xcr-oracle',     source: 'XCR', target: 'partner-oracle',        type: 'bgrfc', direction: 'client', callCount: 211_905, process: 'mixed', bucketIds: [], activity: [] },

    // XHD reporting
    { id: 'e-xhd-mssql',      source: 'XHD', target: 'partner-mssql',         type: 'odata', direction: 'client', callCount: 188_440, process: 'untagged', bucketIds: [], activity: [] },

    // Cross-secondary
    { id: 'e-xcd-xhd',        source: 'XCD', target: 'XHD', type: 'rfc', direction: 'bidi', callCount: 95_212, process: 'mixed', bucketIds: [], activity: [] },
    { id: 'e-xcr-xcs',        source: 'XCR', target: 'XCS', type: 'qrfc', direction: 'client', callCount: 41_788, process: 'o2c_payment', bucketIds: [], activity: [] },
];

export const FIXTURE_ACTIVITY: ActivityRow[] = [
    { id: 'a-1', sourceSid: 'XCP', direction: 'server', partner: 'w16s24xcp_XCP_00', callCount: 6_515_542 },
    { id: 'a-2', sourceSid: 'XCP', direction: 'client', partner: 'oracle_db_prod',    callCount: 1_840_400 },
    { id: 'a-3', sourceSid: 'XHQ', direction: 'client', partner: 'w16s24xhq_XHQ_00',  callCount: 2_277_288 },
    { id: 'a-4', sourceSid: 'XHD', direction: 'server', partner: 'w16s24xhq_XHQ_00',  callCount: 294_528 },
    { id: 'a-5', sourceSid: 'XCS', direction: 'client', partner: 'cpi_runtime_prod',  callCount: 167_433 },
    { id: 'a-6', sourceSid: 'XHQ', direction: 'client', partner: 'sap_btp_eu10',      callCount: 408_911 },
];

/** Sparkline series for the bottom panel — calls per hour over last 24h. */
export const FIXTURE_CALLS_PER_HOUR: number[] = [
    412_000, 388_000, 401_220, 446_000, 478_910, 512_300, 533_440, 561_220,
    590_140, 612_044, 588_900, 564_010, 540_220, 521_440, 502_010, 488_120,
    476_220, 452_120, 433_040, 421_180, 408_910, 392_040, 384_220, 401_330,
];
