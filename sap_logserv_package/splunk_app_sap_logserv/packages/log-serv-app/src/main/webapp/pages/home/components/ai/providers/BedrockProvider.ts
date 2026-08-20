import {
    AIProvider,
    ConfigValidation,
    ModelDescriptor,
    PrivacyPosture,
    StreamOptions,
} from './AIProvider';
import { buildOutboundPayload } from './outboundGuard';
import { readSecret, requireSecret } from './credentials';
import {
    AnthropicStreamEvent,
    buildAnthropicMessagesBody,
    newTranslatorState,
    translateAnthropicEvent,
} from './anthropicEventTranslator';

/**
 * BedrockProvider — Anthropic Claude via AWS Bedrock.
 *
 * Why Bedrock over direct Anthropic for many enterprise customers:
 *   - Platform-level zero data retention (no Anthropic ZDR addendum needed)
 *   - Customer's existing AWS contract / IAM / billing
 *   - In-region inference (e.g., ap-south-1) for data-residency reqs
 *
 * Auth: this implementation uses **Bedrock API Keys** (a feature
 * released for Bedrock Runtime in 2024) rather than SigV4 signing.
 * Bedrock API Keys are bearer tokens issued from the IAM console,
 * scoped to a specific principal — they avoid the complexity of
 * implementing AWS Signature V4 in browser code.
 *
 * If a customer cannot use Bedrock API Keys, the recommended path is
 * a server-side proxy via a Splunk REST handler in the Data TA that
 * holds AWS credentials and signs requests on behalf of the user.
 * That implementation is deferred to Phase G.
 *
 * Streaming: Bedrock's `InvokeModelWithResponseStream` returns a binary
 * event-stream protocol (NOT SSE). Each message is:
 *
 *   [4B totalLength][4B headersLength][4B preludeCRC]
 *   [headersLength bytes of headers]
 *   [payload bytes]
 *   [4B messageCRC]
 *
 * For Anthropic-on-Bedrock, the payload is JSON of shape:
 *   { "chunk": { "bytes": "<base64-encoded Anthropic event JSON>" } }
 *
 * We base64-decode and translate via the shared `translateAnthropicEvent`
 * helper. CRC validation is skipped (browser-side; a malformed stream
 * would only manifest as garbled text, not a security issue).
 *
 * Credentials read from passwords.conf:
 *   - realm `logserv_ai_assistant_bedrock`, name `api_key`     — required (Bedrock API Key bearer token)
 *   - realm `logserv_ai_assistant_bedrock`, name `region`      — required (e.g., us-east-1)
 *   - realm `logserv_ai_assistant_bedrock`, name `endpoint`    — optional override (e.g., VPC endpoint)
 */

const PROVIDER_NAME = 'bedrock';

/**
 * Static curated baseline — the floor the model picker can never fall
 * below. Bedrock model ids vary by account/region (dated segments,
 * inference profiles), which is exactly why `listModels` (real
 * ListFoundationModels discovery) matters most for this provider — the
 * discovered list carries the customer's ACTUAL invokable ids; this
 * baseline just needs plausible current-generation defaults. Refreshed
 * session 079 (was the Opus 4.7 / Sonnet 4.6 generation).
 */
const BEDROCK_MODELS: ReadonlyArray<ModelDescriptor> = [
    {
        id: 'anthropic.claude-opus-4-8-v1:0',
        label: 'Claude Opus 4.8 (Bedrock)',
        contextWindow: 1_000_000,
        supportsTools: true,
    },
    {
        id: 'anthropic.claude-sonnet-5-v1:0',
        label: 'Claude Sonnet 5 (Bedrock)',
        contextWindow: 1_000_000,
        supportsTools: true,
    },
    {
        id: 'anthropic.claude-haiku-4-5-v1:0',
        label: 'Claude Haiku 4.5 (Bedrock)',
        contextWindow: 200_000,
        supportsTools: true,
    },
];

const DEFAULT_POSTURE: PrivacyPosture = {
    noTraining: true,
    zeroRetention: true, // Bedrock platform-level guarantee
    abuseLoggingDays: 0,
    notes:
        'AWS Bedrock — platform-level zero-retention guarantee, no Anthropic addendum required. ' +
        'Inference happens in the configured AWS region.',
};

export interface BedrockProviderOptions {
    /** Override AWS region (default: read from passwords.conf `region`). */
    region?: string;
    /** Override endpoint (default: bedrock-runtime.<region>.amazonaws.com). */
    endpoint?: string;
    /** Override privacy posture. */
    privacyPosture?: PrivacyPosture;
    /** Resolve API key — defaults to `readSecret('bedrock', 'api_key')`. */
    apiKeyResolver?: () => Promise<string>;
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
}

export class BedrockProvider implements AIProvider {
    readonly name = PROVIDER_NAME;
    readonly label = 'AWS Bedrock (Claude)';
    readonly models = BEDROCK_MODELS;
    readonly privacyPosture: PrivacyPosture;

    private readonly regionOverride?: string;
    private readonly endpointOverride?: string;
    private readonly apiKeyResolver: () => Promise<string>;
    private readonly fetchImpl: typeof fetch;

    private cachedRegion: string | null = null;
    private cachedEndpoint: string | null = null;

    constructor(opts: BedrockProviderOptions = {}) {
        this.privacyPosture = opts.privacyPosture ?? DEFAULT_POSTURE;
        this.regionOverride = opts.region;
        this.endpointOverride = opts.endpoint;
        this.apiKeyResolver =
            opts.apiKeyResolver ?? (() => requireSecret(PROVIDER_NAME, 'api_key'));
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    }

    private async getRegion(): Promise<string> {
        if (this.regionOverride) return this.regionOverride;
        if (this.cachedRegion) return this.cachedRegion;
        const r = await requireSecret(PROVIDER_NAME, 'region');
        this.cachedRegion = r;
        return r;
    }

    private async getEndpoint(): Promise<string> {
        if (this.endpointOverride) return this.endpointOverride;
        if (this.cachedEndpoint) return this.cachedEndpoint;
        const explicit = await readSecret(PROVIDER_NAME, 'endpoint');
        if (explicit) {
            this.cachedEndpoint = explicit.replace(/\/$/, '');
            return this.cachedEndpoint;
        }
        const region = await this.getRegion();
        this.cachedEndpoint = `https://bedrock-runtime.${region}.amazonaws.com`;
        return this.cachedEndpoint;
    }

    async stream(opts: StreamOptions): Promise<void> {
        const payload = buildOutboundPayload(opts.messages, opts.tools);

        let apiKey: string;
        let endpoint: string;
        try {
            apiKey = await this.apiKeyResolver();
            endpoint = await this.getEndpoint();
        } catch (err) {
            opts.onChunk({
                type: 'error',
                error: {
                    code: 'config_missing',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
            return;
        }

        const body = buildAnthropicMessagesBody(payload, null, opts.maxTokens ?? 4096, true);
        const url = `${endpoint}/model/${encodeURIComponent(opts.model)}/invoke-with-response-stream`;

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/vnd.amazon.eventstream',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: opts.abortSignal,
            });
        } catch (err) {
            const aborted = err instanceof DOMException && err.name === 'AbortError';
            opts.onChunk({
                type: 'error',
                error: {
                    code: aborted ? 'aborted' : 'network_error',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
            return;
        }

        if (!response.ok || !response.body) {
            const errBody = await safeReadBody(response);
            opts.onChunk({
                type: 'error',
                error: {
                    code: `http_${response.status}`,
                    message: `Bedrock returned HTTP ${response.status}: ${errBody}`,
                },
            });
            return;
        }

        try {
            const state = newTranslatorState();
            await consumeBedrockEventStream(
                response.body,
                (evt) => {
                    if (state.terminated) return;
                    if (!evt) return;
                    translateAnthropicEvent(evt, state, opts.onChunk);
                },
                opts.abortSignal,
            );
            if (!state.terminated) {
                opts.onChunk({ type: 'done', stopReason: state.stopReason });
            }
        } catch (err) {
            const aborted = err instanceof DOMException && err.name === 'AbortError';
            opts.onChunk({
                type: 'error',
                error: {
                    code: aborted ? 'aborted' : 'stream_error',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
        }
    }

    /**
     * Model discovery — ListFoundationModels on the `bedrock.` control
     * plane (the same endpoint validateConfig already probes with the
     * stored bearer key). Filters to what THIS provider can actually
     * run: providerName=Anthropic (we stream via the Anthropic event
     * translator — only Claude models work), ON_DEMAND inference, TEXT
     * output, streaming-capable, ACTIVE lifecycle. Best-effort — the
     * control-plane host's browser CORS posture and the API key's
     * authorization for the List action vary by account; any failure
     * degrades to the static baseline via the caller. Session 079 /
     * build 276.
     */
    async listModels(): Promise<ReadonlyArray<ModelDescriptor>> {
        const apiKey = await this.apiKeyResolver();
        const region = await this.getRegion();
        const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
        const response = await this.fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (response.status === 401 || response.status === 403) {
            throw new Error(`Bedrock API key rejected (HTTP ${response.status}) on model list.`);
        }
        if (!response.ok) {
            throw new Error(`Bedrock returned HTTP ${response.status} on model list (region=${region}).`);
        }
        const json = (await response.json()) as {
            modelSummaries?: Array<{
                modelId?: string;
                modelName?: string;
                providerName?: string;
                inferenceTypesSupported?: string[];
                outputModalities?: string[];
                responseStreamingSupported?: boolean;
                modelLifecycle?: { status?: string };
            }>;
        };
        const summaries = Array.isArray(json?.modelSummaries) ? json.modelSummaries : [];
        return summaries
            .filter(
                (m) =>
                    typeof m?.modelId === 'string' &&
                    m.modelId.length > 0 &&
                    m.providerName === 'Anthropic' &&
                    (m.inferenceTypesSupported ?? []).indexOf('ON_DEMAND') >= 0 &&
                    (m.outputModalities ?? []).indexOf('TEXT') >= 0 &&
                    m.responseStreamingSupported !== false &&
                    (m.modelLifecycle?.status ?? 'ACTIVE') === 'ACTIVE',
            )
            .map((m) => ({
                id: m.modelId as string,
                label: m.modelName ? `${m.modelName} (Bedrock)` : (m.modelId as string),
                contextWindow: 0, // metadata overlay fills in
                supportsTools: true,
            }));
    }

    async validateConfig(): Promise<ConfigValidation> {
        let apiKey: string | null;
        let region: string;
        try {
            apiKey = await readSecret(PROVIDER_NAME, 'api_key');
            region = await this.getRegion();
        } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (!apiKey) {
            return {
                ok: false,
                reason:
                    'Bedrock API key not set. Configure via Splunk REST: ' +
                    `POST /services/storage/passwords realm=logserv_ai_assistant_${PROVIDER_NAME} name=api_key password=<bedrock-api-key>`,
            };
        }
        if (!region) {
            return {
                ok: false,
                reason: 'Bedrock region not set. Set realm=logserv_ai_assistant_bedrock name=region password=us-east-1 (or your region).',
            };
        }
        // Cheap probe: list inference profiles via bedrock control plane.
        // The `bedrock` (not `bedrock-runtime`) endpoint exposes
        // /foundation-models which any valid bearer key can read.
        try {
            const probeUrl = `https://bedrock.${region}.amazonaws.com/foundation-models`;
            const response = await this.fetchImpl(probeUrl, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (response.status === 401 || response.status === 403) {
                return { ok: false, reason: `Bedrock API key rejected (HTTP ${response.status}).` };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    reason: `Bedrock returned HTTP ${response.status} on validate (region=${region}).`,
                };
            }
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `Bedrock unreachable: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}

/**
 * Read AWS event-stream messages from a fetch response body and invoke
 * `onEvent` for each successfully decoded inner Anthropic event JSON.
 *
 * Wire format per AWS docs:
 *   https://docs.aws.amazon.com/AmazonS3/latest/API/RESTSelectObjectAppendix.html
 *
 *   Each message:
 *     totalLength       u32 BE   (entire message including this field)
 *     headersLength     u32 BE
 *     preludeCRC        u32 BE   (we skip validation)
 *     headers           [N pairs]  (we skim for `:event-type` to recognize 'chunk')
 *     payload           [bytes]
 *     messageCRC        u32 BE   (we skip validation)
 *
 *   Header pair:
 *     name_length       u8
 *     name              [name_length bytes UTF-8]
 *     value_type        u8         (7 = string)
 *     value_length      u16 BE     (only present for string type)
 *     value             [value_length bytes UTF-8]
 *
 * For Anthropic-on-Bedrock, the chunk payload JSON is:
 *   { "bytes": "<base64-of-anthropic-event-json>" }
 *
 * Implemented as a callback (not an async generator) to keep the
 * project on `lib: es2017` without needing downlevel iteration.
 */
const consumeBedrockEventStream = async (
    stream: ReadableStream<Uint8Array>,
    onEvent: (evt: AnthropicStreamEvent | null) => void,
    abortSignal?: AbortSignal,
): Promise<void> => {
    const reader = stream.getReader();
    let buffer: Uint8Array = new Uint8Array(0);

    try {
        while (true) {
            if (abortSignal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const { value, done } = await reader.read();
            if (done) return;
            buffer = concatBytes(buffer, value);

            // Peel off complete messages.
            while (buffer.length >= 4) {
                const totalLength = readU32BE(buffer, 0);
                if (totalLength === 0 || totalLength > 16 * 1024 * 1024) {
                    // Sanity: no real Bedrock event will exceed 16 MB.
                    // Resync by dropping a byte to avoid wedging on a
                    // malformed stream.
                    buffer = buffer.slice(1);
                    break;
                }
                if (buffer.length < totalLength) break; // wait for more bytes

                const message = buffer.slice(0, totalLength);
                buffer = buffer.slice(totalLength);

                const decoded = decodeBedrockMessage(message);
                if (decoded) onEvent(decoded);
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* best-effort */ }
    }
};

const decodeBedrockMessage = (msg: Uint8Array): AnthropicStreamEvent | null => {
    if (msg.length < 16) return null;
    const headersLength = readU32BE(msg, 4);
    // skip prelude CRC at bytes 8..12
    const headersStart = 12;
    const headersEnd = headersStart + headersLength;
    if (headersEnd + 4 > msg.length) return null;
    const payloadStart = headersEnd;
    const payloadEnd = msg.length - 4; // strip trailing message CRC
    const payloadBytes = msg.slice(payloadStart, payloadEnd);

    // Parse headers — we only need `:event-type` and `:message-type`.
    const headers = parseEventStreamHeaders(msg.slice(headersStart, headersEnd));
    const eventType = headers[':event-type'];
    const messageType = headers[':message-type'];

    // Bedrock streams "event"-typed messages with event-type='chunk',
    // and "exception"-typed messages on error.
    if (messageType === 'exception' || messageType === 'error') {
        try {
            const text = new TextDecoder('utf-8').decode(payloadBytes);
            const json = JSON.parse(text) as { Message?: string; message?: string };
            return {
                type: 'error',
                error: {
                    type: eventType ?? messageType,
                    message: json.Message ?? json.message ?? text,
                },
            };
        } catch {
            return { type: 'error', error: { type: 'parse', message: 'Bedrock exception event with unparseable body' } };
        }
    }

    if (eventType !== 'chunk') return null;

    let payloadJson: { bytes?: string };
    try {
        const text = new TextDecoder('utf-8').decode(payloadBytes);
        payloadJson = JSON.parse(text) as { bytes?: string };
    } catch {
        return null;
    }

    if (!payloadJson.bytes) return null;
    let innerJsonText: string;
    try {
        // base64 decode → UTF-8 text → JSON
        const binary = atob(payloadJson.bytes);
        const innerBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) innerBytes[i] = binary.charCodeAt(i);
        innerJsonText = new TextDecoder('utf-8').decode(innerBytes);
    } catch {
        return null;
    }

    try {
        return JSON.parse(innerJsonText) as AnthropicStreamEvent;
    } catch {
        return null;
    }
};

const parseEventStreamHeaders = (bytes: Uint8Array): Record<string, string> => {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < bytes.length) {
        if (i + 1 > bytes.length) break;
        const nameLen = bytes[i]; i += 1;
        if (i + nameLen + 1 > bytes.length) break;
        const name = new TextDecoder('utf-8').decode(bytes.slice(i, i + nameLen));
        i += nameLen;
        const valueType = bytes[i]; i += 1;
        // Type 7 = string with u16 length; other types skipped (we don't need them).
        if (valueType !== 7) {
            // Skip remaining bytes of unknown type — best-effort: bail.
            break;
        }
        if (i + 2 > bytes.length) break;
        const valueLen = (bytes[i] << 8) | bytes[i + 1];
        i += 2;
        if (i + valueLen > bytes.length) break;
        const value = new TextDecoder('utf-8').decode(bytes.slice(i, i + valueLen));
        i += valueLen;
        out[name] = value;
    }
    return out;
};

const readU32BE = (bytes: Uint8Array, offset: number): number =>
    (bytes[offset] << 24) >>> 0 |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    // Copy `b` into a fresh Uint8Array to normalize its underlying buffer
    // type — fetch readers can return Uint8Array<ArrayBufferLike> in
    // strict TypeScript, which doesn't unify with the Uint8Array<ArrayBuffer>
    // produced by `new Uint8Array(n)`.
    const bCopy = new Uint8Array(b.length);
    bCopy.set(b);
    const out = new Uint8Array(a.length + bCopy.length);
    out.set(a, 0);
    out.set(bCopy, a.length);
    return out;
};

const safeReadBody = async (response: Response): Promise<string> => {
    try {
        return (await response.text()).slice(0, 500);
    } catch {
        return '<no body>';
    }
};
