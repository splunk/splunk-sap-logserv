import { HOST_ADDED_METRICS } from './filterCapability';
import { HostGateState, hostGateKey } from './queryFilters';

/**
 * Can a metric that gained `host` in build 397 take the host filter over this time
 * range?
 *
 * Its rows written by an earlier build have no `host`, and `| search host="a"` would
 * drop them with no sign of it. So while a filter is on, one small KV Store read per
 * metric asks whether the range holds such a row: `{"metric":"m","host":null}` matches
 * a row with no `host` (the REST query refuses `$exists`). A row means 'old', and the
 * panel takes its raw arm, as it did before build 397: slower, and correct. An hour stops
 * holding such rows when the hourly search or a Backfill recounts it, which overwrites
 * each with a zero row whose `host` is "(none)".
 *
 * 'ready' takes more than an empty answer, because KV Store can answer with nothing while
 * it warms up after a restart: a second read must find a row of the metric in the range.
 * A metric with no rows in the range therefore reads as 'old' too, and a raw arm with
 * nothing to find is quick. Any failure to answer costs speed, never numbers. Nothing here
 * runs with no filter on.
 *
 * Both reads go through the (metric, host, bucket_ts) index these collections carry, so
 * they answer at once at any size.
 */

const APP = 'splunk_app_sap_logserv';
const KV_DATA = `/en-US/splunkd/__raw/servicesNS/nobody/${APP}/storage/collections/data`;

/** A check that takes longer than this counts as a failure to answer. */
export const HOST_GATE_TIMEOUT_MS = 15000;

/** The answer is read again this often while a filter stays on: a rebuild moves a metric
 *  from 'old' to 'ready', and a read during a warm-up must not stand. */
export const HOST_GATE_TTL_MS = 5 * 60 * 1000;

export interface HostGateMetric {
    collection: string;
    metric: string;
}

export const HOST_GATE_METRICS: readonly HostGateMetric[] = Object.keys(HOST_ADDED_METRICS).reduce<HostGateMetric[]>(
    (all, collection) => all.concat(HOST_ADDED_METRICS[collection].map((metric) => ({ collection, metric }))),
    [],
);

/** The KV Store query: a row of this metric with no `host`, at or after the bound. */
export const hostGateQuery = (metric: string, lowerSec: number | null): string =>
    JSON.stringify(lowerSec === null ? { metric, host: null } : { metric, bucket_ts: { $gte: lowerSec }, host: null });

/** The control: any row of this metric at or after the bound. */
export const hostGateControlQuery = (metric: string, lowerSec: number | null): string =>
    JSON.stringify(lowerSec === null ? { metric } : { metric, bucket_ts: { $gte: lowerSec } });

const oneRowUrl = (collection: string, query: string): string =>
    `${KV_DATA}/${collection}?output_mode=json&limit=1&query=${encodeURIComponent(query)}`;

export const hostGateUrl = (collection: string, metric: string, lowerSec: number | null): string =>
    oneRowUrl(collection, hostGateQuery(metric, lowerSec));

export const hostGateControlUrl = (collection: string, metric: string, lowerSec: number | null): string =>
    oneRowUrl(collection, hostGateControlQuery(metric, lowerSec));

/** Every metric in one state: what a page sees while its check runs. */
export const uniformHostGate = (state: HostGateState): Record<string, HostGateState> => {
    const out: Record<string, HostGateState> = {};
    HOST_GATE_METRICS.forEach(({ collection, metric }) => {
        out[hostGateKey(collection, metric)] = state;
    });
    return out;
};

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const checkOne = async (
    { collection, metric }: HostGateMetric,
    lowerSec: number | null,
    signal: AbortSignal,
    fetchImpl: FetchImpl,
): Promise<HostGateState> => {
    const rowCount = async (url: string): Promise<number | null> => {
        const res = await fetchImpl(url, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            signal,
        });
        if (!res.ok) return null;
        const rows: unknown = await res.json();
        return Array.isArray(rows) ? rows.length : null;
    };
    try {
        if ((await rowCount(hostGateUrl(collection, metric, lowerSec))) !== 0) return 'old';
        return (await rowCount(hostGateControlUrl(collection, metric, lowerSec))) === 1 ? 'ready' : 'old';
    } catch (_e) {
        return 'old';
    }
};

/** One state per metric. Never rejects: a metric it cannot answer for is 'old'. */
export const readHostGate = async (
    lowerSec: number | null,
    signal: AbortSignal,
    fetchImpl: FetchImpl = (url, init) => fetch(url, init),
): Promise<Record<string, HostGateState>> => {
    const states = await Promise.all(HOST_GATE_METRICS.map((m) => checkOne(m, lowerSec, signal, fetchImpl)));
    const out: Record<string, HostGateState> = {};
    HOST_GATE_METRICS.forEach(({ collection, metric }, i) => {
        out[hostGateKey(collection, metric)] = states[i];
    });
    return out;
};
