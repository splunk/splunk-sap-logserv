import {
    AIProvider,
    ConfigValidation,
    ModelDescriptor,
    PrivacyPosture,
    StreamOptions,
} from './AIProvider';
import { buildOutboundPayload } from './outboundGuard';
import { consumeJsonSSEStream } from './sseUtils';
import { readSecret, requireSecret } from './credentials';
import {
    AnthropicStreamEvent,
    buildAnthropicMessagesBody,
    newTranslatorState,
    translateAnthropicEvent,
} from './anthropicEventTranslator';

/**
 * AnthropicProvider — direct API to api.anthropic.com.
 *
 * Streaming wire format reference:
 *   https://docs.anthropic.com/en/api/messages-streaming
 *
 * Why direct fetch (no @anthropic-ai/sdk):
 *   - Bundle size: the SDK is ~150 KB; we use ~3 KB of it
 *   - All we need is HTTPS + standard SSE parsing, both built into browsers
 *   - Type system enforces our outbound guard, not the SDK's looser types
 *
 * Privacy invariant: every outbound payload is built via
 * `buildOutboundPayload()` from outboundGuard, which both the type system
 * (Visible-only) and the runtime forbidden-key scan have already
 * validated. Tool *results* never reach this code path — they live on
 * the React side as `Hidden<MCPToolResult>` and are rendered into the UI
 * directly.
 *
 * Event translation lives in `anthropicEventTranslator.ts` so
 * BedrockProvider can reuse it (same payloads, different transport).
 */

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_VERSION = '2023-06-01';

/**
 * Static curated baseline — the floor the model picker can never fall
 * below. Discovery (`listModels`) appends the vendor's CURRENT list on
 * top of this at the state layer, so new model generations appear
 * without an App release; this array just needs to be current at
 * release time. Refreshed session 079 / build 275 (was the Opus 4.7 /
 * Sonnet 4.6 generation).
 */
const ANTHROPIC_MODELS: ReadonlyArray<ModelDescriptor> = [
    {
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
        contextWindow: 1_000_000,
        supportsTools: true,
    },
    {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        supportsTools: true,
    },
    {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        supportsTools: true,
    },
];

/**
 * Default privacy posture for the direct Anthropic API. Reflects the
 * "no enterprise ZDR addendum on file" baseline — admins who have a
 * signed addendum should pass a custom `privacyPosture` to the
 * constructor (and update the privacy banner accordingly).
 */
const DEFAULT_POSTURE: PrivacyPosture = {
    noTraining: true, // default Anthropic policy for API traffic
    zeroRetention: false, // baseline; flip to true with ZDR addendum
    abuseLoggingDays: 30, // standard 30-day abuse-review window
    notes:
        'Direct Anthropic API. Default abuse-logging window is 30 days. ' +
        'For zero-retention, sign Anthropic Enterprise ZDR addendum and update this posture in admin config.',
};

export interface AnthropicProviderOptions {
    /** Override API base URL (e.g., for compatibility proxies). */
    apiUrl?: string;
    /** Override `anthropic-version` request header. */
    apiVersion?: string;
    /** Override privacy posture (admin sets based on their actual contract). */
    privacyPosture?: PrivacyPosture;
    /** Resolve the API key — defaults to `readSecret('anthropic', 'api_key')`. */
    apiKeyResolver?: () => Promise<string>;
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements AIProvider {
    readonly name = 'anthropic';
    readonly label = 'Anthropic Claude (direct API)';
    readonly models = ANTHROPIC_MODELS;
    readonly privacyPosture: PrivacyPosture;

    private readonly apiUrl: string;
    private readonly apiVersion: string;
    private readonly apiKeyResolver: () => Promise<string>;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: AnthropicProviderOptions = {}) {
        this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
        this.apiVersion = opts.apiVersion ?? DEFAULT_VERSION;
        this.privacyPosture = opts.privacyPosture ?? DEFAULT_POSTURE;
        this.apiKeyResolver =
            opts.apiKeyResolver ??
            (() => requireSecret('anthropic', 'api_key'));
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    }

    async stream(opts: StreamOptions): Promise<void> {
        // Build payload via the outbound guard. Throws OutboundGuardError
        // if the type-system check is bypassed and forbidden data slipped
        // through. Never let the stream proceed without this.
        const payload = buildOutboundPayload(opts.messages, opts.tools);

        let apiKey: string;
        try {
            apiKey = await this.apiKeyResolver();
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

        const body = buildAnthropicMessagesBody(payload, opts.model, opts.maxTokens ?? 4096, false);

        let response: Response;
        try {
            response = await this.fetchImpl(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': this.apiVersion,
                    'anthropic-dangerous-direct-browser-access': 'true',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
                signal: opts.abortSignal,
            });
        } catch (err) {
            const aborted =
                err instanceof DOMException && err.name === 'AbortError';
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
                    message: `Anthropic API returned HTTP ${response.status}: ${errBody}`,
                },
            });
            return;
        }

        try {
            const state = newTranslatorState();
            await consumeJsonSSEStream<AnthropicStreamEvent>(
                response.body,
                (evt) => {
                    if (state.terminated) return;
                    translateAnthropicEvent(evt, state, opts.onChunk);
                },
                opts.abortSignal,
            );
            if (!state.terminated) {
                // Stream ended without explicit message_stop — emit done so
                // the UI doesn't hang in 'streaming'.
                opts.onChunk({ type: 'done', stopReason: state.stopReason });
            }
        } catch (err) {
            const aborted =
                err instanceof DOMException && err.name === 'AbortError';
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
     * GET one page of /v1/models. Shared by validateConfig (which only
     * cares about the status code) and listModels (which parses +
     * paginates) — validation IS discovery: same request, same headers,
     * same CORS posture (proven live since Phase D).
     */
    private requestModelsPage(apiKey: string, afterId?: string): Promise<Response> {
        const baseUrl = this.apiUrl.replace(/\/v1\/messages\/?$/, '/v1/models');
        const url =
            `${baseUrl}?limit=100` +
            (afterId ? `&after_id=${encodeURIComponent(afterId)}` : '');
        return this.fetchImpl(url, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': this.apiVersion,
                'anthropic-dangerous-direct-browser-access': 'true',
            },
        });
    }

    async validateConfig(): Promise<ConfigValidation> {
        let apiKey: string | null;
        try {
            apiKey = await readSecret('anthropic', 'api_key');
        } catch (err) {
            return {
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
            };
        }
        if (!apiKey) {
            return {
                ok: false,
                reason:
                    'Anthropic API key not set. Configure via Splunk REST: ' +
                    'POST /services/storage/passwords realm=logserv_ai_assistant_anthropic name=api_key password=<sk-ant-...>',
            };
        }
        // Cheap validation: GET /v1/models. Returns 200 + JSON list on
        // success; 401 if the key is invalid.
        try {
            const response = await this.requestModelsPage(apiKey);
            if (response.status === 401) {
                return { ok: false, reason: 'Anthropic API key is invalid (401).' };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    reason: `Anthropic API returned HTTP ${response.status} on validate.`,
                };
            }
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `Anthropic API unreachable: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /**
     * Model discovery — GET /v1/models, paginated via has_more/last_id
     * (page-count hard-capped defensively). The list is chat-clean
     * (Anthropic serves only conversational models), so no filtering is
     * needed. `max_input_tokens` (present since Mar 2026) feeds
     * contextWindow directly; 0 lets the caller's metadata overlay fill
     * it in for older API responses. Session 079 / build 275.
     */
    async listModels(): Promise<ReadonlyArray<ModelDescriptor>> {
        const apiKey = await this.apiKeyResolver();
        const out: ModelDescriptor[] = [];
        let afterId: string | undefined;
        for (let page = 0; page < 5; page += 1) {
            const response = await this.requestModelsPage(apiKey, afterId);
            if (response.status === 401) {
                throw new Error('Anthropic API key is invalid (401).');
            }
            if (!response.ok) {
                throw new Error(`Anthropic API returned HTTP ${response.status} on model list.`);
            }
            const json = (await response.json()) as AnthropicModelsPage;
            const data = Array.isArray(json?.data) ? json.data : [];
            for (const m of data) {
                if (!m || typeof m.id !== 'string') continue;
                out.push({
                    id: m.id,
                    label:
                        typeof m.display_name === 'string' && m.display_name.length > 0
                            ? m.display_name
                            : m.id,
                    contextWindow:
                        typeof m.max_input_tokens === 'number' && m.max_input_tokens > 0
                            ? m.max_input_tokens
                            : 0,
                    supportsTools: true,
                });
            }
            if (!json?.has_more || typeof json?.last_id !== 'string' || !json.last_id) break;
            afterId = json.last_id;
        }
        return out;
    }
}

/** Wire shape of GET /v1/models (fields we read; the rest ignored). */
interface AnthropicModelsPage {
    data?: Array<{
        id?: string;
        display_name?: string;
        max_input_tokens?: number;
    }>;
    has_more?: boolean;
    last_id?: string | null;
}

const safeReadBody = async (response: Response): Promise<string> => {
    try {
        return (await response.text()).slice(0, 500);
    } catch {
        return '<no body>';
    }
};
