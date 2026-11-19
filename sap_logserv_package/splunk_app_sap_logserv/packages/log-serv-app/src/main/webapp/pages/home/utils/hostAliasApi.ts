// `username` is a runtime constant exposed by Splunk Web's `window.$C`
// global. Empty string outside Splunk Web (tests / local dev).
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { KvRow, readAllKvRows } from './kvPagedRead';
import { HostAliasRow, MAX_ROWS, hasForbiddenChars, isDeletableKey, sanitizeAliasRow } from './hostAlias';

/**
 * The KV client of the host name table, Settings > Host Names (App build 400).
 *
 * Collection `logserv_host_aliases`: every role reads it (the dashboards show
 * the names), only the admin tier writes it (metadata/default.meta), so the
 * write functions here work only for an admin; the Settings page mounts the
 * editor behind its admin gate. No saved search writes it, it is not a
 * Dashboard Data collection (a Clear never touches it) and nothing trims it.
 *
 * Writes:
 *  - upsertHostAliases: batch_save in chunks of at most BATCH_SAVE_MAX rows
 *    (Splunk's default max_documents_per_batch_save). Every row carries its
 *    `_key`, so batch_save inserts or replaces by key: an import merges into
 *    the table, it never empties it. There is deliberately no replace-all:
 *    deleting first would leave every viewer an empty table mid-import. A chunk
 *    counts as written only when the server answers with a JSON list of one key
 *    per row (as batch_save does); any other answer, a 200 page that is no such
 *    list included (a sign-in or proxy page), is reported as a failure.
 *  - deleteHostAlias: one row by key. A key that could address the collection
 *    (empty, dots, a slash, a backslash, a percent sign, a question mark, a
 *    number sign or a semicolon), or that is not one the App could write, is
 *    refused before any request (isDeletableKey): a DELETE on the collection
 *    URL itself would delete every row.
 * An HTTP error names the status and, when the answer carries one, Splunk's own
 * message (messages[0].text of a JSON body, the first <msg> of an XML one).
 * Every written row gets updated_at (epoch seconds) and updated_by (the
 * signed-in Splunk user, as the AI Assistant's audit events name it).
 *
 * Reads: readAllHostAliases walks the collection page by page
 * (utils/kvPagedRead), at most MAX_ROWS rows, and returns the rows
 * sanitizeAliasRow accepts with `complete` (false when more rows are stored),
 * `storedCount` (the rows read, valid or not) and `invalidCount` (those refused).
 *
 * CSRF: the same X-Splunk-Form-Key header as the other KV writers
 * (state/dashboardRefreshPersistence.ts, topology/persistence.ts).
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const COLLECTION = 'logserv_host_aliases';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;

/** Rows per batch_save request: Splunk's default limits.conf [kvstore]
 *  max_documents_per_batch_save. */
export const BATCH_SAVE_MAX = 1000;

const readCsrfToken = (): string => {
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

const mutatingHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

const currentUser = (): string => (typeof splunkUsername === 'string' ? splunkUsername : '');

/** The most characters of Splunk's own message an error repeats. */
const MAX_SERVER_TEXT = 300;

/** The five predefined XML entities. */
const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** The XML entity and character references Splunk's error bodies use, as text.
 *  A reference to no valid character is kept as written. */
const decodeXmlText = (s: string): string =>
    s.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|quot|apos|amp);/gi, (all: string, ref: string) => {
        const lower = ref.toLowerCase();
        const named = XML_ENTITIES[lower];
        if (named !== undefined) {
            return named;
        }
        const n = lower.charAt(1) === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        const valid = Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
        return valid ? String.fromCodePoint(n) : all;
    });

/** `s` on one line, read by code point: every character hasForbiddenChars
 *  refuses (control, direction and invisible characters, those outside the Basic
 *  Multilingual Plane among them) and every lone surrogate as a space, runs of
 *  whitespace as one space, trimmed. Longer than MAX_SERVER_TEXT characters
 *  (code points): the first MAX_SERVER_TEXT, trimmed, then "...", so the cut
 *  never falls inside a surrogate pair. */
const oneLine = (s: string): string => {
    // Array.from walks the text by code point (the string iterator, as for...of does): a surrogate pair is one
    // character, a lone surrogate one of its own.
    const out = Array.from(s)
        .map((ch) => {
            const unit = ch.charCodeAt(0);
            const lone = ch.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
            return lone || hasForbiddenChars(ch) ? ' ' : ch;
        })
        .join('');
    // No lone surrogate is left, so Array.from splits only between whole characters.
    const chars = Array.from(out.replace(/\s+/g, ' ').trim());
    return chars.length > MAX_SERVER_TEXT ? `${chars.slice(0, MAX_SERVER_TEXT).join('').trim()}...` : chars.join('');
};

/**
 * Splunk's own text of an error answer, or '' when it has none: messages[0].text
 * of a JSON body ({"messages":[{"type":"ERROR","text":"..."}]}), else the first
 * <msg> element of an XML one (<response><messages><msg type="ERROR">...</msg>),
 * on one line (oneLine). It is the server's words only: nothing is added, and a
 * 403 is not turned into a list of roles (the editor is shown only to the roles
 * that may write the table, so a 403 there has another cause, which Splunk's
 * text names). Never throws.
 */
const serverMessageOf = async (resp: Response): Promise<string> => {
    let body = '';
    try {
        body = await resp.text();
    } catch (_e) {
        return '';
    }
    let text = '';
    let parsed: unknown;
    let isJson = false;
    try {
        parsed = JSON.parse(body);
        isJson = true;
    } catch (_e) {
        isJson = false;
    }
    if (isJson) {
        const messages =
            parsed !== null && typeof parsed === 'object' ? (parsed as { messages?: unknown }).messages : undefined;
        const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
        const t = first !== null && typeof first === 'object' ? (first as { text?: unknown }).text : undefined;
        text = typeof t === 'string' ? t : '';
    } else {
        const m = /<msg\b[^>]*>([\s\S]*?)<\/msg>/i.exec(body);
        text = m ? decodeXmlText(m[1]) : '';
    }
    return oneLine(text);
};

/** `base`, then ": " and Splunk's own text of the answer when it has one. */
const withServerMessage = async (base: string, resp: Response): Promise<string> => {
    const text = await serverMessageOf(resp);
    return text !== '' ? `${base}: ${text}` : base;
};

interface StoredAliasRow extends KvRow {
    [field: string]: unknown;
}

export interface HostAliasReadOptions {
    signal?: AbortSignal;
}

/** What readAllHostAliases returns. */
export interface HostAliasRead {
    /** The valid rows (sanitizeAliasRow) among the first MAX_ROWS stored. */
    rows: HostAliasRow[];
    /** False when the collection holds more than MAX_ROWS rows, valid or not:
     *  `rows` is then not the whole table (and which rows were left unread is
     *  not defined), so the editor must say so. */
    complete: boolean;
    /** The stored rows read, valid or not: at most MAX_ROWS. It is what the
     *  table holds against MAX_ROWS when `complete` is true. */
    storedCount: number;
    /** The rows among those read that sanitizeAliasRow refuses (written outside
     *  the App): stored and counted, but in no `rows`, so the editor can neither
     *  show nor delete them. storedCount = rows.length + invalidCount. */
    invalidCount: number;
}

/**
 * The valid rows of the table, at most MAX_ROWS rows read, whether that was
 * every stored row, and how many rows were read and how many of them were
 * refused. Rows that fail sanitizeAliasRow are left out of `rows` (they still
 * count towards MAX_ROWS, in storedCount and invalidCount). Rejects on an HTTP
 * error or an aborted read, so the caller can tell a failed read from an empty
 * table.
 */
export const readAllHostAliases = async (options: HostAliasReadOptions = {}): Promise<HostAliasRead> => {
    const read = await readAllKvRows<StoredAliasRow>(KV_BASE, { maxRows: MAX_ROWS, signal: options.signal });
    const stored = read.rows.slice(0, MAX_ROWS);
    const rows: HostAliasRow[] = [];
    let invalidCount = 0;
    stored.forEach((row) => {
        const clean = sanitizeAliasRow(row);
        if (clean !== null) {
            rows.push(clean);
        } else {
            invalidCount += 1;
        }
    });
    return {
        rows,
        complete: read.complete && read.rows.length <= MAX_ROWS,
        storedCount: stored.length,
        invalidCount,
    };
};

/** One batch_save request that did not confirm all of its rows. */
export interface HostAliasChunkFailure {
    /** Index of the chunk's first row in the list passed in. */
    from: number;
    /** Index after its last row. */
    to: number;
    /** HTTP status, or null when the request did not complete. */
    status: number | null;
    message: string;
}

export interface HostAliasWriteResult {
    /** Rows the server confirmed. */
    written: number;
    failures: HostAliasChunkFailure[];
}

/**
 * Insert or replace rows by key, in chunks of BATCH_SAVE_MAX. Each row is
 * sanitized again and written with its derived `_key`, updated_at and
 * updated_by; a stored_key is never written. A failed chunk does not stop the
 * others (each is an upsert on its own keys); every failure is reported.
 *
 * Throws, before any request: on an empty list (there is nothing to write, and
 * an empty write must never look like a cleared table), on more than MAX_ROWS
 * rows, on a row sanitizeAliasRow refuses, and on two rows with one key.
 */
export const upsertHostAliases = async (rows: ReadonlyArray<HostAliasRow>): Promise<HostAliasWriteResult> => {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('upsertHostAliases: no rows to write');
    }
    if (rows.length > MAX_ROWS) {
        throw new Error(`upsertHostAliases: ${rows.length} rows; at most ${MAX_ROWS} can be written at once`);
    }
    const now = Math.floor(Date.now() / 1000);
    const user = currentUser();
    const keys = new Set<string>();
    const records = rows.map((row, i) => {
        const clean = sanitizeAliasRow({ match_value: row.match_value, alias: row.alias, description: row.description });
        if (clean === null) {
            throw new Error(`upsertHostAliases: row ${i + 1} is not a valid host name row`);
        }
        const { _key: key } = clean;
        if (keys.has(key)) {
            throw new Error(`upsertHostAliases: row ${i + 1} repeats the host of an earlier row`);
        }
        keys.add(key);
        const record: Record<string, string | number> = {
            _key: key,
            match_value: clean.match_value,
            alias: clean.alias,
            description: clean.description || '',
            updated_at: now,
        };
        if (user !== '') {
            record.updated_by = user;
        }
        return record;
    });

    const failures: HostAliasChunkFailure[] = [];
    let written = 0;
    for (let from = 0; from < records.length; from += BATCH_SAVE_MAX) {
        const chunk = records.slice(from, from + BATCH_SAVE_MAX);
        const to = from + chunk.length;
        try {
            // One chunk at a time on purpose: an import must not flood the KV Store.
            // eslint-disable-next-line no-await-in-loop
            const resp = await fetch(`${KV_BASE}/batch_save`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body: JSON.stringify(chunk),
            });
            if (!resp.ok) {
                // eslint-disable-next-line no-await-in-loop
                const message = await withServerMessage(`HTTP ${resp.status} ${resp.statusText}`.trim(), resp);
                failures.push({ from, to, status: resp.status, message });
            } else {
                let saved: unknown = null;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    saved = await resp.json();
                } catch (_e) {
                    saved = null;
                }
                // batch_save answers with the list of the keys it saved, one per row: only that confirms the
                // chunk. A shorter list is a partial write; anything else (not JSON, an object, a longer list,
                // an empty body, a sign-in or proxy page answered with 200) confirms no row.
                if (Array.isArray(saved) && saved.length === chunk.length) {
                    written += chunk.length;
                } else if (Array.isArray(saved) && saved.length < chunk.length) {
                    written += saved.length;
                    failures.push({
                        from,
                        to,
                        status: resp.status,
                        message: `the server confirmed ${saved.length} of ${chunk.length} rows`,
                    });
                } else {
                    failures.push({ from, to, status: resp.status, message: 'the server did not confirm the rows' });
                }
            }
        } catch (e) {
            failures.push({ from, to, status: null, message: e instanceof Error ? e.message : String(e) });
        }
    }
    return { written, failures };
};

/**
 * Delete one row by its key: `stored_key ?? _key` of a row read back (see
 * sanitizeAliasRow). A row already gone (404) counts as deleted. Throws on any
 * other HTTP error (with Splunk's own message when the answer has one), and -
 * before any request - on a key isDeletableKey refuses: empty or only dots or
 * blanks (or a segment of them), a slash, a backslash, a percent sign, a
 * question mark, a number sign or a semicolon (one that could address the
 * collection), a control, direction or invisible character, or longer than
 * 1,024 characters.
 */
export const deleteHostAlias = async (key: string): Promise<void> => {
    if (!isDeletableKey(key)) {
        throw new Error('deleteHostAlias: refused a key this page does not send in a delete (isDeletableKey)');
    }
    const resp = await fetch(`${KV_BASE}/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: mutatingHeaders(),
    });
    if (resp.status === 404) {
        return;
    }
    if (!resp.ok) {
        throw new Error(await withServerMessage(`KV Store delete failed: HTTP ${resp.status}`, resp));
    }
};
