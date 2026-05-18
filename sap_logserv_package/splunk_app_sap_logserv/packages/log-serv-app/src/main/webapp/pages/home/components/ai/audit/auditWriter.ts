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
 * REST endpoint, which forwards them into the `ai_assistant_audit`
 * index defined in the splunk_idx_sap_logserv app.
 *
 * The writer batches events client-side (5-second flush window or
 * 10-event batch) so a busy chat session doesn't issue an HTTP request
 * per token. Events are buffered in memory only — on tab close, any
 * unflushed events are best-effort posted via `navigator.sendBeacon`.
 *
 * Auth: relies on the user's existing Splunk session cookie. The
 * receivers/simple endpoint is part of standard Splunk Web's surface —
 * no special CSRF token needed for cookie-authenticated POSTs from the
 * Splunk Web origin.
 *
 * Failure mode: if the audit endpoint returns non-2xx, the writer logs
 * to console.error and discards the batch. We do NOT block the user's
 * AI interaction on audit-write success — that would be a denial-of-
 * service vector. The trade-off: in a brief Splunk indexer outage,
 * some audit events are lost. The session-id + seq fields let admins
 * detect gaps post-hoc.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §6.5, §9.1 (audit row).
 */

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 10;

/**
 * Local audit-index name. Defaults to `ai_assistant_audit` (matches the
 * LogServ Index App's default indexes.conf and the
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
        try {
            const response = await this.fetchImpl(endpoint, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Splunk-Form-Key': readCsrfToken(),
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body,
            });
            if (!response.ok) {
                // eslint-disable-next-line no-console
                console.error(
                    `[AuditWriter] flush failed: HTTP ${response.status}. ${batch.length} events dropped.`,
                );
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[AuditWriter] flush threw:', err);
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
     * Best-effort flush during page unload. Uses sendBeacon so the
     * browser doesn't cancel the request mid-flight.
     *
     * Known limitation: sendBeacon cannot set custom headers, so this
     * path can't include the CSRF token Splunk Web requires for
     * mutating __raw POSTs. Unload-time flushes will fail with HTTP
     * 401 until either the receivers/simple endpoint is reached
     * via a CSRF-exempt path, or the buffer is flushed via the
     * normal `flush()` path before unload.
     */
    private flushOnUnload(): void {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        this.buffer = [];
        const body = batch.map((e) => JSON.stringify(e)).join('\n');
        const endpoint = this.endpointOverride ?? buildAuditEndpoint();
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([body], { type: 'application/json' });
            navigator.sendBeacon(endpoint, blob);
        }
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
     * audit-write problems don't break the saving UX).
     *
     * Added in build 83 for OWASP LLM02 Tier 2 elevation audit events.
     */
    static async postOneOff(event: AuditEvent): Promise<void> {
        try {
            const response = await fetch(buildAuditEndpoint(), {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Splunk-Form-Key': readCsrfToken(),
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify(event),
            });
            if (!response.ok) {
                // eslint-disable-next-line no-console
                console.error(
                    `[AuditWriter] postOneOff failed: HTTP ${response.status}. Event dropped.`,
                );
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[AuditWriter] postOneOff threw:', err);
        }
        // One-off events also dual-write to the HEC forwarder, when
        // configured. Failures here can't cleanly emit an
        // `audit_forwarder_failure` event because there's no buffered
        // writer — instead, post the failure as another one-off. We
        // skip non-forwardable categories to avoid recursion.
        const cfg = forwarderConfig;
        if (cfg.enabled && !NON_FORWARDABLE_CATEGORIES.has(event.category)) {
            const outcome = await forwardToHec([event], cfg, fetch);
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
                // Local-only — failure events are never forwarded.
                try {
                    await fetch(buildAuditEndpoint(), {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Splunk-Form-Key': readCsrfToken(),
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: JSON.stringify(failureEvent),
                    });
                } catch (_e) {
                    // eslint-disable-next-line no-console
                    console.error('[AuditWriter] postOneOff: forwarder-failure write also failed.');
                }
            }
        }
    }
}
