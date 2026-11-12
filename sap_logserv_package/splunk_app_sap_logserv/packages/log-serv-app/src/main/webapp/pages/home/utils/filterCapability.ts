/**
 * filterCapability — which stored rollup metrics can take the SID and Host
 * filters (build 395; the six slowest rollups gained `host` in build 397).
 *
 * A rollup row can only be filtered on a field it stores, and many metrics
 * aggregate `host` away. This table says, per collection and metric, whether
 * `host` and `sap_sid` survive the aggregate's `stats ... by`. A metric with
 * neither has to read raw events while a filter is on (`utils/queryFilters.ts`).
 *
 * Held equal to the `*_aggregate` stanzas of default/savedsearches.conf by
 * queryFilters.consistency-test, so a rollup that gains a field shows up there
 * instead of quietly staying on the slower raw path.
 *
 * Lists only the collections the query splice can meet. Host Details and Data
 * Pipeline Overview build their own host fragments (hostdetails, hostrole,
 * pipeline, stmap); Multi-Cloud Overview and Environment Topology are out of the
 * filter, as they are out of the Cloud filter.
 */

export interface MetricFields {
    /** Metrics whose rows store `host`. */
    host: readonly string[];
    /** Metrics whose rows store `sap_sid`. */
    sapSid: readonly string[];
}

/** The "metric" of a collection whose rows carry no `metric` field. */
export const NO_METRIC = '*';

export const ROLLUP_FILTER_FIELDS: Readonly<Record<string, MetricFields>> = {
    logserv_abapnet_rollup: { host: [], sapSid: ['icmclient', 'vol'] },
    logserv_beaconing_detail_rollup: { host: [], sapSid: [] },
    logserv_beaconing_rollup: { host: [], sapSid: [] },
    logserv_cloudconn_rollup: { host: [], sapSid: [] },
    logserv_compliance_rollup: { host: ['main', 'password', 'permgrant', 'userchg'], sapSid: [] },
    logserv_dns_rollup: { host: ['main'], sapSid: [] },
    logserv_hana_category_rollup: { host: ['main'], sapSid: [] },
    logserv_hana_trace_rollup: { host: [], sapSid: ['durop', 'main'] },
    logserv_linux_rollup: {
        host: ['cgsfw', 'fw', 'hosts', 'kernel', 'lockup', 'oom', 'pam', 'sapapp', 'sapinst', 'tcpoom', 'total'],
        sapSid: ['sapapp', 'sapinst'],
    },
    logserv_perimeter_rollup: {
        host: ['activity', 'dnscount', 'dnsq', 'dnstype', 'fw', 'proxy', 'proxydom'],
        sapSid: [],
    },
    logserv_proxy_rollup: { host: [], sapSid: [] },
    logserv_saprouter_rollup: { host: [], sapSid: [] },
    logserv_sapservices_rollup: { host: ['main', 'ssl'], sapSid: [] },
    logserv_severity_rollup: { host: ['authfail', 'icmsev', 'tophost', 'toterr', 'trend', 'web'], sapSid: [] },
    logserv_web_timing_rollup: { host: ['wd_host'], sapSid: [] },
    logserv_webdisp_slowtrace_rollup: { host: [], sapSid: [] },
    logserv_windows_rollup: { host: ['main'], sapSid: [] },
    logserv_wp_perf_rollup: { host: ['wperr'], sapSid: ['abap', 'dp', 'uptime', 'wp', 'wperr'] },
    logserv_xstack_auth_rollup: { host: ['fail', 'failip', 'hanauser'], sapSid: [] },
};

/**
 * The metrics that gained `host` in build 397. Their rows written by an earlier
 * build have no `host`, and an install keeps those rows until a Backfill or an
 * hourly run recounts their hour, or retention ages them out. A filter on `host` would silently
 * drop them, so while a filter is on these metrics stay on the rollup only for a
 * time range that holds none of them (`utils/hostGate.ts`).
 */
export const HOST_ADDED_METRICS: Readonly<Record<string, readonly string[]>> = {
    logserv_compliance_rollup: ['main', 'password', 'permgrant', 'userchg'],
    logserv_linux_rollup: ['kernel', 'sapapp', 'total'],
    logserv_perimeter_rollup: ['activity', 'dnscount', 'dnsq', 'dnstype', 'proxy', 'proxydom'],
    logserv_sapservices_rollup: ['main', 'ssl'],
    logserv_severity_rollup: ['authfail', 'icmsev', 'trend', 'web'],
    logserv_xstack_auth_rollup: ['fail', 'failip', 'hanauser'],
};

const has = (list: readonly string[] | undefined, metric: string | null): boolean =>
    !!list && list.indexOf(metric === null ? NO_METRIC : metric) !== -1;

export const metricStoresHost = (collection: string, metric: string | null): boolean =>
    has(ROLLUP_FILTER_FIELDS[collection]?.host, metric);

export const metricStoresSapSid = (collection: string, metric: string | null): boolean =>
    has(ROLLUP_FILTER_FIELDS[collection]?.sapSid, metric);

export const metricGainedHost = (collection: string, metric: string | null): boolean =>
    has(HOST_ADDED_METRICS[collection], metric);

/**
 * `sap_sid` on these collections comes partly from SAP's monitoring lines, whose
 * `--sid` can be compound: `A44_A43` is HANA system A44 with tenant A43. Every
 * other rollup takes it from a log path, /usr/sap/<SID>/, which never is.
 */
export const COMPOUND_SAP_SID_COLLECTIONS: readonly string[] = ['logserv_linux_rollup'];
