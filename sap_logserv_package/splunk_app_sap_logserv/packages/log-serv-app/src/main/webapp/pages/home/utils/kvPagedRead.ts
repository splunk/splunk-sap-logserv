/**
 * Reading a whole KV Store query over REST (build 396).
 *
 * One GET of storage/collections/data/<collection> never returns more than
 * limits.conf [kvstore] allows: max_rows_per_query rows (default 50,000) and
 * max_size_per_result_mb megabytes (default 50). The row cap is silent, an HTTP 200
 * with no hint that rows are missing, and `limit=0` does not lift it: it means "as
 * many as the cap allows". Environment Topology read with limit=0 from build 188 to
 * build 395; at Last 90 days on the reference system it saw 36% of its node events
 * and 88% of its edge calls, and called the data stale because the rows it lost were
 * the newest.
 *
 * So a read walks the result with `skip` until the server returns an EMPTY page. It
 * never stops at a short page, because a page can be short for either cap, at
 * whatever value a customer set it, with more rows behind it. `skip` moves by what
 * the page held, not by what was asked for.
 *
 * `skip` is not a snapshot. A row written during the read can shift the rows behind
 * it onto the next page, so rows are kept once per `_key`. A row deleted during the
 * read can shift rows past it unread, and nothing here can tell: a Clear, or a nightly
 * retention (a full-collection overwrite) running during the read, can show too few
 * rows until the next read, as it could when one request read everything.
 */

/** A page under max_size_per_result_mb (50 MB by default) up to 5 KB a row. The
 *  Environment Topology rows average under 600 bytes. */
export const KV_PAGE_ROWS = 10000;

/** Pages in a row that may hold nothing new before a read gives up. One can happen
 *  honestly, when a page's worth of rows is written ahead of the read between two
 *  requests; three mean the server is not moving through the result. */
const MAX_ALL_SEEN_PAGES = 3;

export interface KvRow {
    _key?: string;
}

export interface KvBucketRow extends KvRow {
    bucket_ts: number;
}

export interface KvReadOptions {
    /** Query parameters other than limit, skip and output_mode. */
    params?: Record<string, string>;
    pageRows?: number;
    /** Stop after this many rows. Unset: read every row. */
    maxRows?: number;
    signal?: AbortSignal;
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface KvPagedRead<T> {
    rows: T[];
    /** False only when maxRows stopped the read with rows still behind it. */
    complete: boolean;
}

export interface KvBucketRead<T> extends KvPagedRead<T> {
    /** On a read stopped by maxRows: the rows cover this bucket_ts and later, every
     *  row of it included. null on a complete read. */
    completeFromTs: number | null;
}

/**
 * Every row the query matches, in the order the server returns them.
 * Throws on an HTTP error, on a body that is not a list, and after MAX_ALL_SEEN_PAGES
 * pages in a row with no new row, so a read either returns what it says or reaches the
 * caller's error path. An aborted read rejects with the browser's AbortError.
 */
export const readAllKvRows = async <T extends KvRow>(
    url: string,
    options: KvReadOptions = {},
): Promise<KvPagedRead<T>> => {
    const { params = {}, pageRows = KV_PAGE_ROWS, maxRows = Infinity, signal } = options;
    const doFetch = options.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
    const rows: T[] = [];
    const seen = new Set<string>();
    let skip = 0;
    let allSeenPages = 0;
    for (;;) {
        const room = maxRows - rows.length;
        const qs = new URLSearchParams(params);
        // With no room left this asks only whether a row exists past the limit.
        qs.set('limit', String(room > 0 ? Math.min(pageRows, room) : 1));
        qs.set('skip', String(skip));
        qs.set('output_mode', 'json');
        // eslint-disable-next-line no-await-in-loop
        const res = await doFetch(`${url}?${qs.toString()}`, { credentials: 'same-origin', signal });
        if (!res.ok) {
            throw new Error(`KV Store fetch failed: ${res.status} ${res.statusText}`);
        }
        // eslint-disable-next-line no-await-in-loop
        const page = (await res.json()) as unknown;
        if (!Array.isArray(page)) {
            throw new Error('KV Store fetch failed: the response is not a list of rows');
        }
        if (page.length === 0) return { rows, complete: true };
        if (room <= 0) return { rows, complete: false };
        let added = 0;
        (page as T[]).forEach((row) => {
            const key = row._key;
            if (key === undefined) {
                rows.push(row);
            } else if (!seen.has(key)) {
                seen.add(key);
                rows.push(row);
                added += 1;
            }
        });
        allSeenPages = added === 0 ? allSeenPages + 1 : 0;
        if (allSeenPages >= MAX_ALL_SEEN_PAGES) {
            throw new Error(`KV Store fetch failed: no new rows at skip=${skip}`);
        }
        skip += page.length;
    }
};

/**
 * The rows of a collection whose bucket_ts is inside the window, oldest first.
 *
 * Read newest first, so a read stopped by maxRows keeps the newest rows, the ones a
 * freshness check and a reader care about, and then put back in the order the same
 * query returns with no `sort` (ascending on the by_bucket_ts index): consumers take
 * labels and types from the first row they meet, so a read that loses nothing must
 * hand them the same sequence. Needs an accelerated field on bucket_ts.
 *
 * On a stopped read the oldest bucket read may hold only some of its rows, so it is
 * dropped and completeFromTs names the oldest bucket read in full. A single bucket
 * larger than maxRows stays, named as the start.
 */
export const readKvBucketWindow = async <T extends KvBucketRow>(
    url: string,
    earliestTs: number,
    latestTs: number,
    options: KvReadOptions = {},
): Promise<KvBucketRead<T>> => {
    const read = await readAllKvRows<T>(url, {
        ...options,
        params: {
            ...options.params,
            query: JSON.stringify({ bucket_ts: { $gte: earliestTs, $lte: latestTs } }),
            sort: 'bucket_ts:-1',
        },
    });
    const rows = read.rows.slice().reverse();
    if (read.complete || rows.length === 0) {
        return { rows, complete: read.complete, completeFromTs: null };
    }
    const cutBucket = rows[0].bucket_ts;
    const whole = rows.filter((r) => r.bucket_ts !== cutBucket);
    if (whole.length === 0) {
        return { rows, complete: false, completeFromTs: cutBucket };
    }
    return { rows: whole, complete: false, completeFromTs: whole[0].bucket_ts };
};

/** The latest start among reads stopped by their limit: from there on, all of them
 *  are complete. null when none was stopped. */
export const commonCompleteFromTs = (starts: ReadonlyArray<number | null>): number | null =>
    starts.reduce<number | null>((acc, ts) => {
        if (ts === null) return acc;
        return acc === null ? ts : Math.max(acc, ts);
    }, null);
