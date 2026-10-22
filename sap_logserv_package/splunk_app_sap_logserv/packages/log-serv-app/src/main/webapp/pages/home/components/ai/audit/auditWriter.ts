import { AuditEvent, AuditForwarderFailureEvent } from './auditTypes';

/**
 * Audit forwarder configuration. When `enabled === true` and `url` +
 * `hecToken` are non-empty, every audit event the writer flushes to
 * the local Splunk index is ALSO POSTed to the HEC endpoint at
 * `<url>/services/collector/event` with `Authorization: Splunk
 * <hecToken>` and a body of newline-delimited HEC envelopes.
 *
 * Configured globally (module-level state) via `setAuditForwarderConfig`
 * — App.tsx applies after `loadAIAssistantConfig` resolves; the
 * Settings page re-applies after a save. This avoids threading the
 * config through every AuditWriter constructor call site, which
 * would force changes to the buffered-singleton in AIAssistantProvider
 * AND the static `postOneOff` helper.
 *
 * Build 98 / session 022.
 */
export interface AuditForwarderConfig {
    enabled: boolean;
    /** Destination HEC base URL — must be the URL up to but NOT
     *  including `/services/collector/event`. Empty or whitespace
     *  treated as disabled. */
    url: string;
    /** HEC token. Empty string treated as disabled. Loaded from
     *  passwords.conf realm `logserv_ai_assistant_forwarder` name
     *  `hec_token`. Read by the admin Settings page; non-admin users
     *  may not be able to read this and will silently skip forwarding. */
    hecToken: string;
    /** Optional remote index name. Empty → use HEC token's default. */
    index: string;
    /** Source field stamped on forwarded events. */
    source: string;
}

let forwarderConfig: AuditForwarderConfig = {
    enabled: false,
    url: '',
    hecToken: '',
    index: '',
    source: 'logserv_ai_assistant_remote',
};

/**
 * Replace the module-level forwarder config. Subsequent flushes use
 * the new values. Call after `loadAIAssistantConfig` resolves at app
 * mount, and again after the Settings page persists a change.
 *
 * Passing `undefined` for the token leaves the previous token in place
 * — useful when the admin saves Settings without re-entering the
 * token (the password-edit UI uses an empty input to mean "no change").
 */
export const setAuditForwarderConfig = (
    cfg: Partial<AuditForwarderConfig>,
): void => {
    forwarderConfig = {
        ...forwarderConfig,
        ...cfg,
    };
};

/** Read the current forwarder config — exposed only for tests. */
export const getAuditForwarderConfig = (): AuditForwarderConfig =>
    ({ ...forwarderConfig });

/**
 * Categories that must NEVER be forwarded — would otherwise cause an
 * unbounded retry loop when the destination is unreachable. Each
 * forwarder failure produces a `audit_forwarder_failure` event in the
 * LOCAL index; if we forwarded that too, the second forward would
 * also fail and produce another event ad infinitum.
 */
const NON_FORWARDABLE_CATEGORIES: ReadonlySet<string> = new Set([
    'audit_forwarder_failure',
]);

/**
 * Build the HEC body for a batch — newline-delimited envelopes per the
 * Splunk HTTP Event Collector spec. Each line is a separate envelope
 * containing the original audit event in the `event` field, with the
 * destination index / source / sourcetype stamped at envelope-level.
 *
 * The `time` field uses ms-precision Unix epoch — Splunk HEC accepts
 * ISO-8601 in newer versions but the Unix epoch is universally
 * compatible.
 */
const buildHecBody = (
    events: ReadonlyArray<AuditEvent>,
    cfg: AuditForwarderConfig,
): string => {
    return events
        .map((e) => {
            const envelope: Record<string, unknown> = {
                event: e,
                sourcetype: 'logserv:ai_assistant:audit',
                source: cfg.source || 'logserv_ai_assistant_remote',
                time: Math.floor(Date.parse(e.timestamp) / 1000) || Math.floor(Date.now() / 1000),
            };
            if (cfg.index && cfg.index.length > 0) {
                envelope.index = cfg.index;
            }
            return JSON.stringify(envelope);
        })
        .join('\n');
};

/**
 * Strip query string and credentials from a URL for safe logging.
 * The HEC token is a header, not a URL component, so only the path is
 * sensitive — but defense in depth.
 */
const sanitizeUrlForLog = (raw: string): string => {
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch (_e) {
        return raw.split('?')[0];
    }
};

/**
 * Attempt to forward `events` to the configured HEC endpoint. Returns
 * a sentinel describing the outcome. Never throws.
 *
 * `events` is the FILTERED batch — non-forwardable categories already
 * removed by the caller. If `events` is empty, returns `'skipped'`.
 *
 * Caller (flush / postOneOff) is responsible for posting an
 * `audit_forwarder_failure` event in the LOCAL index when this
 * returns a failure outcome. We don't write the failure here because
 * AuditWriter's local-write path is the source of truth for what gets
 * indexed locally.
 */
type ForwardOutcome =
    | { status: 'ok' }
    | { status: 'skipped' }
    | { status: 'failed'; reason: string };

const forwardToHec = async (
    events: ReadonlyArray<AuditEvent>,
    cfg: AuditForwarderConfig,
    fetchImpl: typeof fetch,
): Promise<ForwardOutcome> => {
    if (!cfg.enabled) return { status: 'skipped' };
    if (!cfg.url || cfg.url.trim().length === 0) {
        return { status: 'failed', reason: 'no_url' };
    }
    if (!cfg.hecToken || cfg.hecToken.length === 0) {
        return { status: 'failed', reason: 'no_token' };
    }
    if (events.length === 0) return { status: 'skipped' };

    const endpoint = cfg.url.replace(/\/+$/, '') + '/services/collector/event';
    const body = buildHecBody(events, cfg);
    try {
        const resp = await fetchImpl(endpoint, {
            method: 'POST',
            // Cross-origin: we deliberately omit credentials so the
            // browser doesn't send unrelated cookies. HEC auth is via
            // the Authorization header.
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Splunk ${cfg.hecToken}`,
            },
            body,
        });
        if (!resp.ok) {
            return { status: 'failed', reason: `http_${resp.status}` };
        }
        return { status: 'ok' };
    } catch (e) {
        return {
            status: 'failed',
            reason: 'fetch_threw',
        };
    }
};

/**
 * Audit writer — posts events to Splunk's `services/receivers/simple`
 * REST endpoint (through Splunk Web's splunkd proxy), which indexes them
 * into the local audit index: `logserv_ai_assistant_audit` by default,
 * defined in the Data TA's indexes.conf (the `audit_index_name` setting
 * renames it; see `setLocalAuditIndex`).
 *
 * The writer batches events client-side (5-second flush window or
 * 10-event batch) so a busy chat session doesn't issue an HTTP request
 * per token. Events are buffered in memory only — on tab close, any
 * unflushed events are best-effort posted by `flushOnUnload` with a
 * keepalive fetch (the request outlives the page; its body is capped).
 *
 * Auth: every write runs as the signed-in user, on the Splunk Web
 * session cookie, and carries Splunk Web's CSRF headers (see
 * `readCsrfToken` below; without them the POST is refused with HTTP
 * 401). Splunk also requires the `edit_tcp` or the `edit_log_alert_event`
 * capability on receivers/simple (restmap.conf `[input:simple]`). Of the
 * default roles `admin` holds both and `power` holds
 * `edit_log_alert_event`, so for a user whose only role is `user` every
 * write is refused with HTTP 403 and that user's AI Assistant activity is
 * not in the audit index (build 385; seen on Splunk 9.4.3). The docs (AI
 * Assistant > Audit Log) name the capabilities and the trade-off of
 * granting them.
 *
 * Failure mode: if the audit endpoint returns non-2xx or the request
 * fails, the writer logs to console.error, discards the batch and
 * reports the outcome to the write-health listeners
 * (`onAuditWriteResult`), from which the chat panel shows a warning.
 * We do NOT block the user's AI interaction on audit-write success —
 * that would be a denial-of-service vector. The trade-off: in a brief
 * Splunk indexer outage, or for a user without edit_tcp or
 * edit_log_alert_event, audit events
 * are lost. The session-id + seq fields let admins detect gaps
 * post-hoc.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §6.5, §9.1 (audit row).
 */

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 10;

/**
 * Local audit-index name. Defaults to `logserv_ai_assistant_audit` (the
 * index the Data TA's indexes.conf defines, the shipped
 * `audit_index_name` in ai_assistant_settings.conf and the
 * `sap_logserv_audit_idx_macro` definition). When the admin changes the
 * `audit_index_name` field in `ai_assistant_settings.conf`, App.tsx
 * calls `setLocalAuditIndex()` to update this module-level state so
 * subsequent flushes target the new index.
 *
 * Module-level rather than per-writer-instance for the same reason as
 * forwarderConfig above: avoids threading the value through every
 * AuditWriter call site (the buffered singleton in AIAssistantProvider
 * AND the static `postOneOff` helper).
 */
let localAuditIndex = 'logserv_ai_assistant_audit';

/**
 * Update the local audit-index name. Subsequent `flush()` and
 * `postOneOff()` invocations target the new index. Called from
 * `App.tsx` after `loadAIAssistantConfig()` resolves and again whenever
 * the Settings page persists a config change.
 */
export const setLocalAuditIndex = (indexName: string): void => {
    const trimmed = indexName?.trim();
    if (trimmed && trimmed.length > 0) {
        localAuditIndex = trimmed;
    }
};

/** Read the current local audit-index name — exposed for diagnostics + tests. */
export const getLocalAuditIndex = (): string => localAuditIndex;

/**
 * Build the receivers/simple URL for the current audit-index value.
 * Called fresh on every flush so a mid-session config change takes
 * effect on the next flush rather than being baked at module load.
 */
const buildAuditEndpoint = (): string =>
    '/en-US/splunkd/__raw/services/receivers/simple' +
    '?source=logserv_ai_assistant' +
    '&sourcetype=logserv:ai_assistant:audit' +
    `&index=${encodeURIComponent(localAuditIndex)}`;

/**
 * Read the Splunk Web CSRF token from cookies. Splunk Web rejects
 * mutating requests to `/en-US/splunkd/__raw/...` without BOTH:
 *   - `X-Splunk-Form-Key` header matching the `splunkweb_csrf_token_<port>`
 *     cookie value, AND
 *   - `X-Requested-With: XMLHttpRequest` header
 *
 * Same pattern as `aiConfigApi.ts`. Duplicated here (rather than
 * imported) to keep the audit subsystem self-contained.
 *
 * Without these headers the receivers/simple POST returns HTTP 401 with
 * body `Splunk cannot authenticate the request. CSRF validation failed`
 * — a long-standing bug that silently dropped EVERY audit event in the
 * pipeline (vendor_tier1, security_blocked_spl, rate_limited_prompt,
 * vendor_tier2_elevation) until build 84 added the form key and build
 * 85 added the X-Requested-With header. Discovered during build 83
 * verification of the new vendor_tier2_elevation event.
 */
const readCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
    return m ? decodeURIComponent(m[1]) : '';
};

/**
 * The headers every local audit write carries, the page-unload write
 * included: Splunk Web refuses a mutating `__raw` POST without its CSRF
 * form key and the XMLHttpRequest marker (see `readCsrfToken`).
 */
const localWriteHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
    'X-Requested-With': 'XMLHttpRequest',
});

// ── Write-health channel ─────────────────────────────────────────────
//
// Every write to the LOCAL audit index (each flush, each postOneOff
// write and the page-unload write) reports its outcome to the listeners
// registered here, so the chat panel can say that audit events are not
// being written instead of the failure living only in the browser
// console. Fail-open is unchanged: a failed write is still dropped and
// never blocks the AI Assistant. The HEC forwarder's outcomes are not
// reported here; they have their own `audit_forwarder_failure` events.

/** The outcome of one write to the local audit index. */
export interface AuditWriteResult {
    /** True when Splunk accepted the write (HTTP 2xx). */
    ok: boolean;
    /** The HTTP status, or null when no response came back (a network
     *  error, or the browser refused to send the request). */
    status: number | null;
    /** When the outcome was known, epoch ms. */
    when: number;
    /** How many audit events the write carried. */
    events: number;
}

export type AuditWriteListener = (result: AuditWriteResult) => void;

const auditWriteListeners: AuditWriteListener[] = [];

/**
 * Subscribe to local audit-write outcomes; returns the unsubscribe
 * function. Module-level (like the index name and the forwarder config)
 * so the buffered writer and the static `postOneOff` both report. A
 * listener that throws is ignored: it must never break a write.
 */
export const onAuditWriteResult = (listener: AuditWriteListener): (() => void) => {
    auditWriteListeners.push(listener);
    return () => {
        const at = auditWriteListeners.indexOf(listener);
        if (at !== -1) auditWriteListeners.splice(at, 1);
    };
};

const reportAuditWriteResult = (result: AuditWriteResult): void => {
    auditWriteListeners.slice().forEach((listener) => {
        try {
            listener(result);
        } catch (_e) {
            // A listener must never break the writer.
        }
    });
};

/**
 * What the chat panel keeps while local audit writes fail. `status` is
 * the latest failed write's; `when` is when the current run of failures
 * began (epoch ms); `dropped` counts the events that run did not write.
 */
export interface AuditWriteProblem {
    status: number | null;
    when: number;
    dropped: number;
}

/**
 * The problem after `result`: a successful write clears it; a failed one
 * starts it, or extends the current one (the latest status, the first
 * failure's time, the events added up).
 */
export const nextAuditWriteProblem = (
    prev: AuditWriteProblem | null,
    result: AuditWriteResult,
): AuditWriteProblem | null => {
    if (result.ok) return null;
    if (prev === null) {
        return { status: result.status, when: result.when, dropped: result.events };
    }
    return { status: result.status, when: prev.when, dropped: prev.dropped + result.events };
};

/** The words the chat panel shows for a problem. */
export interface AuditWriteProblemText {
    /** The warning's first line. */
    title: string;
    /** The warning's second line: why, and what to do. */
    detail: string;
    /** How many events since when, for example
     *  "3 audit events not written since 2:04:11 PM". */
    since: string;
    /** The note at the top of the "Audit this session" list. */
    modalNote: string;
}

/**
 * The warning text for `problem`, in plain words. Kept in this .ts
 * module rather than in the .tsx banner so the build-time consistency
 * test (utils/auditWriteHealth.consistency-test.ts) can run it.
 * `formatTime` renders an epoch-ms time (the viewer's clock by default).
 */
export const describeAuditWriteProblem = (
    problem: AuditWriteProblem,
    formatTime: (epochMs: number) => string = (ms) => new Date(ms).toLocaleTimeString(),
): AuditWriteProblemText => {
    const { status } = problem;
    let detail: string;
    if (status === 403) {
        detail =
            `Splunk refused the write (HTTP ${status}). Writing the AI Assistant audit log needs the` +
            " edit_log_alert_event or the edit_tcp capability, and Splunk's default user role has neither." +
            ' Ask your Splunk admin; until then your AI Assistant activity in this session is not in the' +
            ' audit log.';
    } else if (status === 401) {
        // Build 381 (audit S4 of build 380): Splunk Web answers 401 for an ended
        // session or a failed CSRF check; a missing capability is a 403. So the
        // session comes first, the capability only if a reload does not help.
        detail =
            `Splunk refused the write (HTTP ${status}). Your Splunk Web session may have ended: reload` +
            ' the page. If it keeps happening after a reload, writing the AI Assistant audit log needs the' +
            " edit_log_alert_event or the edit_tcp capability, and Splunk's default user role has neither:" +
            ' ask your Splunk admin. Until then your AI Assistant activity in this session is not in the' +
            ' audit log.';
    } else if (status === null) {
        detail =
            'The write did not reach Splunk (no response). Until writes succeed again, your AI' +
            ' Assistant activity in this session is not in the audit log.';
    } else {
        detail =
            `Splunk did not accept the write (HTTP ${status}). Until writes succeed again, your AI` +
            ' Assistant activity in this session is not in the audit log. If this continues, ask your' +
            ' Splunk admin.';
    }
    const n = problem.dropped;
    const at = formatTime(problem.when);
    const why = status === null ? 'no response from Splunk' : `HTTP ${status}`;
    return {
        title: 'Audit events are not being written',
        detail,
        since: `${n} audit event${n === 1 ? '' : 's'} not written since ${at}`,
        modalNote:
            `Audit writes have failed since ${at} (${why}): events listed here from about that` +
            ' time on may not be in the audit index.',
    };
};

/**
 * Browsers refuse a keepalive request once the bodies of a page's
 * keepalive requests in flight would pass 64 KiB (the fetch rejects).
 * The page-unload write stays under this, with room for others.
 */
export const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

const utf8Length = (s: string): number =>
    typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(s).length
        : s.length * 3; // an upper bound: no UTF-16 code unit takes more than 3 bytes

/**
 * The newest events whose newline-joined JSON fits in `limitBytes`
 * (UTF-8), in their original order: the body to send, how many events
 * it carries, and how many (the oldest) are left out.
 */
export const fitKeepaliveBatch = (
    events: ReadonlyArray<AuditEvent>,
    limitBytes: number,
): { body: string; sent: number; dropped: number } => {
    const lines: string[] = [];
    let bytes = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const line = JSON.stringify(events[i]);
        const cost = utf8Length(line) + (lines.length > 0 ? 1 : 0);
        if (bytes + cost > limitBytes) break;
        lines.push(line);
        bytes += cost;
    }
    lines.reverse();
    return { body: lines.join('\n'), sent: lines.length, dropped: events.length - lines.length };
};

/** One local write's outcome, with what was thrown when it threw. */
interface LocalWriteOutcome {
    result: AuditWriteResult;
    error?: unknown;
}

/**
 * POST newline-delimited audit events to the local audit index as the
 * signed-in user, and report the outcome to the write-health listeners.
 * Never throws (a `status` of null means the request threw); the caller
 * logs, so each path keeps its own console line. `keepalive` is for the
 * page-unload write, which has to outlive the page.
 */
const postToLocalIndex = async (
    fetchImpl: typeof fetch,
    endpoint: string,
    body: string,
    events: number,
    keepalive = false,
): Promise<LocalWriteOutcome> => {
    let outcome: LocalWriteOutcome;
    try {
        const init: RequestInit = {
            method: 'POST',
            credentials: 'same-origin',
            headers: localWriteHeaders(),
            body,
        };
        if (keepalive) init.keepalive = true;
        const response = await fetchImpl(endpoint, init);
        outcome = { result: { ok: response.ok, status: response.status, when: Date.now(), events } };
    } catch (err) {
        outcome = { result: { ok: false, status: null, when: Date.now(), events }, error: err };
    }
    reportAuditWriteResult(outcome.result);
    return outcome;
};

export interface AuditWriterOptions {
    /** Override endpoint for tests. */
    endpoint?: string;
    /** Override flush interval for tests. */
    flushIntervalMs?: number;
    /** Override batch size for tests. */
    flushBatchSize?: number;
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
}

export class AuditWriter {
    private buffer: AuditEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    /** Endpoint override for tests; production reads `buildAuditEndpoint()`
     *  fresh on every flush so a mid-session audit-index rename takes
     *  effect on the next batch. */
    private readonly endpointOverride: string | undefined;
    private readonly flushIntervalMs: number;
    private readonly flushBatchSize: number;
    private readonly fetchImpl: typeof fetch;
    private closed = false;

    constructor(opts: AuditWriterOptions = {}) {
        this.endpointOverride = opts.endpoint;
        this.flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
        this.flushBatchSize = opts.flushBatchSize ?? FLUSH_BATCH_SIZE;
        // Bind to window.fetch to avoid `Illegal invocation` errors when
        // the impl reads global state.
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));

        // Best-effort flush on tab close.
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pagehide', () => this.flushOnUnload());
            window.addEventListener('beforeunload', () => this.flushOnUnload());
        }

        this.startTimer();
    }

    record(event: AuditEvent): void {
        if (this.closed) return;
        this.buffer.push(event);
        if (this.buffer.length >= this.flushBatchSize) {
            void this.flush();
        }
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        // Splunk receivers/simple accepts one event per request body, but
        // we batch by emitting newline-delimited JSON which Splunk's
        // line breaker handles natively when sourcetype is set.
        const body = batch.map((e) => JSON.stringify(e)).join('\n');
        const endpoint = this.endpointOverride ?? buildAuditEndpoint();
        // Reports the outcome to the write-health listeners itself.
        const { result, error } = await postToLocalIndex(this.fetchImpl, endpoint, body, batch.length);
        if (result.status === null) {
            // eslint-disable-next-line no-console
            console.error('[AuditWriter] flush threw:', error);
        } else if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error(
                `[AuditWriter] flush failed: HTTP ${result.status}. ${batch.length} events dropped.`,
            );
        }

        // Dual-write to the audit forwarder HEC endpoint, when
        // configured. Defense-in-depth: a host-root admin who tampers
        // with the local index now has a divergence with the off-host
        // copy. Build 98 / session 022.
        await this.maybeForward(batch);
    }

    /**
     * Forward the supplied batch to the HEC endpoint when configured,
     * filtering out non-forwardable categories. Failure produces a new
     * `audit_forwarder_failure` event posted ONLY to the local index
     * (NOT forwarded — would loop). Never throws.
     */
    private async maybeForward(batch: ReadonlyArray<AuditEvent>): Promise<void> {
        const cfg = forwarderConfig;
        if (!cfg.enabled) return;
        const forwardable = batch.filter(
            (e) => !NON_FORWARDABLE_CATEGORIES.has(e.category),
        );
        if (forwardable.length === 0) return;
        const outcome = await forwardToHec(forwardable, cfg, this.fetchImpl);
        if (outcome.status === 'failed') {
            // Compose a failure record. The next local-flush window
            // picks this up — we do NOT recurse into flush() here, to
            // avoid stack-depth issues if the failure pattern persists
            // across many batches.
            const failureEvent: AuditForwarderFailureEvent = {
                category: 'audit_forwarder_failure',
                timestamp: new Date().toISOString(),
                user: forwardable[0]?.user ?? 'unknown',
                sessionId: forwardable[0]?.sessionId ?? 'unknown',
                seq: 0,
                batchSize: forwardable.length,
                reason: outcome.reason,
                destinationUrl: sanitizeUrlForLog(cfg.url),
            };
            // Push directly into the buffer; the next flush will pick
            // it up. Push happens after the batch already cleared the
            // local-write step, so the local index will see it on the
            // next flush window.
            this.buffer.push(failureEvent);
            // eslint-disable-next-line no-console
            console.warn(
                `[AuditWriter] HEC forwarder failed (${outcome.reason}); ${forwardable.length} events not forwarded to ${sanitizeUrlForLog(cfg.url)}.`,
            );
        }
    }

    /**
     * Best-effort flush during page unload, with a keepalive fetch: the
     * browser lets the request finish after the page is gone, and it
     * carries the same CSRF headers as every other write. (This path used
     * the Beacon API, which cannot set request headers, so Splunk Web
     * refused every unload write with HTTP 401, for every user.)
     *
     * Browsers cap the bodies of keepalive requests (see
     * KEEPALIVE_BODY_LIMIT_BYTES): when the pending events do not fit,
     * the newest that fit are sent and the rest are dropped, with a
     * console line saying how many. The outcome is reported like any
     * other write's (it matters when the page was only hidden, or the
     * unload was cancelled, and the page is still in use). The HEC
     * forwarder is not called on unload.
     */
    private flushOnUnload(): void {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        const { body, sent, dropped } = fitKeepaliveBatch(batch, KEEPALIVE_BODY_LIMIT_BYTES);
        if (dropped > 0) {
            // eslint-disable-next-line no-console
            console.error(
                `[AuditWriter] unload flush: ${dropped} of ${batch.length} events dropped (over the ${KEEPALIVE_BODY_LIMIT_BYTES}-byte limit for a request sent as the page closes).`,
            );
        }
        if (sent === 0) return;
        const endpoint = this.endpointOverride ?? buildAuditEndpoint();
        void postToLocalIndex(this.fetchImpl, endpoint, body, sent, true).then(({ result, error }) => {
            if (result.status === null) {
                // eslint-disable-next-line no-console
                console.error('[AuditWriter] unload flush threw:', error);
            } else if (!result.ok) {
                // eslint-disable-next-line no-console
                console.error(`[AuditWriter] unload flush failed: HTTP ${result.status}. ${sent} events dropped.`);
            }
        });
    }

    /**
     * Stop the flush timer and flush any remaining events. Use on
     * deliberate AI Assistant teardown (not page unload — that uses
     * `flushOnUnload` automatically).
     */
    async close(): Promise<void> {
        this.closed = true;
        if (this.flushTimer !== null) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }

    private startTimer(): void {
        this.flushTimer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);
    }

    /**
     * Post a single audit event immediately, without spinning up a
     * full AuditWriter (no buffer, no flush timer, no unload listeners).
     *
     * Intended for callers outside the chat session — e.g. the admin
     * Settings page firing a `vendor_tier2_elevation` event after a
     * save. Returns a promise that resolves when the POST completes
     * (or fails — failures are logged to console and otherwise
     * swallowed, matching the buffered-writer's failure semantics so
     * audit-write problems don't break the saving UX). Each local write's
     * outcome is reported to the write-health listeners, as a flush's is.
     *
     * `fetchImpl` is for tests; callers pass only the event. Where the event
 * goes - the local index, and the HEC forwarder when it is on - is read
 * when it is called (build 392).
     *
     * Added in build 83 for OWASP LLM02 Tier 2 elevation audit events.
     */
    static async postOneOff(
        event: AuditEvent,
        fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    ): Promise<void> {
        // Build 392: read before the first await, so the settings in place
        // when the event is posted decide where it goes. The Settings page
        // posts an acknowledgement's event and then saves; the forwarder
        // settings used to be read after the local write, so a save in
        // flight could decide whether the event was also forwarded.
        const endpoint = buildAuditEndpoint();
        const cfg = forwarderConfig;
        const { result, error } = await postToLocalIndex(
            fetchImpl,
            endpoint,
            JSON.stringify(event),
            1,
        );
        if (result.status === null) {
            // eslint-disable-next-line no-console
            console.error('[AuditWriter] postOneOff threw:', error);
        } else if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error(
                `[AuditWriter] postOneOff failed: HTTP ${result.status}. Event dropped.`,
            );
        }
        // One-off events also dual-write to the HEC forwarder, when
        // configured. Failures here can't cleanly emit an
        // `audit_forwarder_failure` event because there's no buffered
        // writer — instead, post the failure as another one-off. We
        // skip non-forwardable categories to avoid recursion.
        if (cfg.enabled && !NON_FORWARDABLE_CATEGORIES.has(event.category)) {
            const outcome = await forwardToHec([event], cfg, fetchImpl);
            if (outcome.status === 'failed') {
                const failureEvent: AuditForwarderFailureEvent = {
                    category: 'audit_forwarder_failure',
                    timestamp: new Date().toISOString(),
                    user: event.user,
                    sessionId: event.sessionId,
                    seq: 0,
                    batchSize: 1,
                    reason: outcome.reason,
                    destinationUrl: sanitizeUrlForLog(cfg.url),
                };
                // Local-only — failure events are never forwarded. Into the
                // event's index (build 392).
                const written = await postToLocalIndex(
                    fetchImpl,
                    endpoint,
                    JSON.stringify(failureEvent),
                    1,
                );
                if (!written.result.ok) {
                    // eslint-disable-next-line no-console
                    console.error('[AuditWriter] postOneOff: forwarder-failure write also failed.');
                }
            }
        }
    }
}
