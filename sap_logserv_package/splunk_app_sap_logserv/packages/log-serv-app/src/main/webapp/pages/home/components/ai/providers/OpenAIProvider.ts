import {
    AIProvider,
    ConfigValidation,
    ModelDescriptor,
    PrivacyPosture,
    StreamOptions,
} from './AIProvider';
import { buildOutboundPayload, VendorMessage, VendorToolDef } from './outboundGuard';
import { markVisible } from '../types';
import { TokenUsage } from '../types/ChunkEvent';
import { consumeJsonSSEStream } from './sseUtils';
import { readSecret, requireSecret } from './credentials';

/**
 * OpenAIProvider — direct API to api.openai.com.
 *
 * Streaming wire format reference:
 *   https://platform.openai.com/docs/api-reference/chat/streaming
 *
 * Differences from Anthropic worth noting:
 *   - Tool calls stream as `delta.tool_calls[i].function.arguments`
 *     fragments — accumulated until `finish_reason='tool_calls'`
 *   - System prompt is a regular `system` role message
 *   - Tool results come back as `role: 'tool'` messages with
 *     `tool_call_id` (we map our `toolResults` field accordingly)
 *   - Stream terminates with `data: [DONE]\n\n`
 */

const DEFAULT_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Static curated baseline — the floor the model picker can never fall
 * below. Discovery (`listModels`) appends the vendor's CURRENT list on
 * top at the state layer. Ids use OpenAI's undated aliases (dated
 * snapshots collapse to their alias in discovery too — see
 * `filterOpenAIModels`). Refreshed session 079 / build 275.
 */
const OPENAI_MODELS: ReadonlyArray<ModelDescriptor> = [
    {
        id: 'gpt-5.1',
        label: 'GPT-5.1',
        contextWindow: 400_000,
        supportsTools: true,
    },
    {
        id: 'gpt-5',
        label: 'GPT-5',
        contextWindow: 400_000,
        supportsTools: true,
    },
    {
        id: 'gpt-4o',
        label: 'GPT-4o',
        contextWindow: 128_000,
        supportsTools: true,
    },
    {
        id: 'o3',
        label: 'o3 (reasoning)',
        contextWindow: 200_000,
        supportsTools: true,
    },
];

/**
 * Filter OpenAI's /v1/models payload down to chat-usable entries.
 *
 * OpenAI's list is noisy — audio/realtime/image/embedding/moderation
 * variants and legacy completion models all share the endpoint — so
 * this is the main design surface of OpenAI discovery (over/under-
 * inclusion is release-notes-visible):
 *
 *   1. ALLOW ids starting `gpt-` / `o<digit>` / `chatgpt-` (chat families)
 *   2. DENY non-chat modality/legacy markers anywhere in the id
 *   3. COLLAPSE dated snapshots (`-YYYY-MM-DD` suffix) when the undated
 *      alias is also present (Q2 — resolved by the user 2026-07-07):
 *      `gpt-4o-2024-11-20` drops when `gpt-4o` exists; a snapshot
 *      WITHOUT an alias is kept (better than hiding a usable model)
 *   4. Sort newest-first by the vendor `created` epoch
 *
 * Pure function, exported for unit-style assertions.
 */
export const filterOpenAIModels = (
    entries: ReadonlyArray<{ id: string; created?: number }>,
): Array<{ id: string; created?: number }> => {
    const ALLOW = /^(gpt-|o\d|chatgpt-)/;
    const DENY = /(audio|realtime|search|transcribe|tts|image|instruct|embedding|moderation|whisper|dall-e|davinci|babbage|curie|ada)/i;
    const chat = entries.filter((m) => ALLOW.test(m.id) && !DENY.test(m.id));
    const idSet = new Set(chat.map((m) => m.id));
    const collapsed = chat.filter((m) => {
        const snapshot = m.id.match(/^(.+)-\d{4}-\d{2}-\d{2}$/);
        return !(snapshot && idSet.has(snapshot[1]));
    });
    return collapsed.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
};

const DEFAULT_POSTURE: PrivacyPosture = {
    noTraining: true, // default OpenAI API policy as of release date
    zeroRetention: false,
    abuseLoggingDays: 30,
    notes:
        'Direct OpenAI API. Default 30-day abuse-logging window. ' +
        'For zero-retention, sign OpenAI Enterprise ZDR addendum and update posture in admin config.',
};

export interface OpenAIProviderOptions {
    /** Override API base URL. */
    apiUrl?: string;
    /** Override privacy posture. */
    privacyPosture?: PrivacyPosture;
    /** Resolve API key — defaults to `readSecret('openai', 'api_key')`. */
    apiKeyResolver?: () => Promise<string>;
    /** Optional org ID header value. */
    organization?: string;
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
    /** Override provider name (used by AzureOpenAIProvider for credential lookup). */
    providerNameOverride?: string;
    /** Override label. */
    labelOverride?: string;
    /** Override model list. */
    modelsOverride?: ReadonlyArray<ModelDescriptor>;
}

export class OpenAIProvider implements AIProvider {
    readonly name: string;
    readonly label: string;
    readonly models: ReadonlyArray<ModelDescriptor>;
    readonly privacyPosture: PrivacyPosture;

    protected readonly apiUrl: string;
    protected readonly apiKeyResolver: () => Promise<string>;
    protected readonly organization: string | undefined;
    protected readonly fetchImpl: typeof fetch;
    protected readonly credentialProviderName: string;

    constructor(opts: OpenAIProviderOptions = {}) {
        this.name = opts.providerNameOverride ?? 'openai';
        this.label = opts.labelOverride ?? 'OpenAI (direct API)';
        this.models = opts.modelsOverride ?? OPENAI_MODELS;
        this.credentialProviderName = opts.providerNameOverride ?? 'openai';
        this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
        this.privacyPosture = opts.privacyPosture ?? DEFAULT_POSTURE;
        this.apiKeyResolver =
            opts.apiKeyResolver ??
            (() => requireSecret(this.credentialProviderName, 'api_key'));
        this.organization = opts.organization;
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    }

    async stream(opts: StreamOptions): Promise<void> {
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

        const body = toOpenAIRequest(payload, opts.model, opts.maxTokens ?? 4096);

        let response: Response;
        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                Accept: 'text/event-stream',
            };
            if (this.organization) headers['OpenAI-Organization'] = this.organization;

            response = await this.fetchImpl(this.apiUrl, {
                method: 'POST',
                headers,
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
                    message: `OpenAI API returned HTTP ${response.status}: ${errBody}`,
                },
            });
            return;
        }

        try {
            await this.consumeStream(response.body, opts);
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

    async validateConfig(): Promise<ConfigValidation> {
        let apiKey: string | null;
        try {
            apiKey = await readSecret(this.credentialProviderName, 'api_key');
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
                    `OpenAI API key not set. Configure via Splunk REST: ` +
                    `POST /services/storage/passwords realm=logserv_ai_assistant_${this.credentialProviderName} name=api_key password=<sk-...>`,
            };
        }
        try {
            const response = await this.requestModelList(apiKey);
            if (response.status === 401) {
                return { ok: false, reason: 'OpenAI API key is invalid (401).' };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    reason: `OpenAI API returned HTTP ${response.status} on validate.`,
                };
            }
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `OpenAI API unreachable: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    /** GET /v1/models — shared by validateConfig and listModels. */
    protected requestModelList(apiKey: string): Promise<Response> {
        const listUrl = this.apiUrl.replace(/\/v1\/chat\/completions\/?$/, '/v1/models');
        const headers: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
        };
        if (this.organization) headers['OpenAI-Organization'] = this.organization;
        return this.fetchImpl(listUrl, { method: 'GET', headers });
    }

    /**
     * Model discovery — GET /v1/models (unpaginated on OpenAI), then
     * `filterOpenAIModels` for the allowlist / deny / snapshot-collapse
     * rules. OpenAI reports no display name or context window on this
     * endpoint, so label = id and contextWindow = 0 (the caller's
     * metadata overlay fills it in). Session 079 / build 275.
     *
     * NOTE: only meaningful on the direct-OpenAI instance. The inner
     * OpenAIProvider that AzureOpenAIProvider composes for streaming is
     * never asked for listModels — Azure has its own deployment-based
     * discovery.
     */
    async listModels(): Promise<ReadonlyArray<ModelDescriptor>> {
        const apiKey = await this.apiKeyResolver();
        const response = await this.requestModelList(apiKey);
        if (response.status === 401) {
            throw new Error('OpenAI API key is invalid (401).');
        }
        if (!response.ok) {
            throw new Error(`OpenAI API returned HTTP ${response.status} on model list.`);
        }
        const json = (await response.json()) as {
            data?: Array<{ id?: string; created?: number }>;
        };
        const entries = (Array.isArray(json?.data) ? json.data : []).filter(
            (m): m is { id: string; created?: number } => typeof m?.id === 'string',
        );
        return filterOpenAIModels(entries).map((m) => ({
            id: m.id,
            label: m.id,
            contextWindow: 0,
            supportsTools: true,
        }));
    }

    /**
     * Translate OpenAI SSE deltas into our ChunkEvent stream.
     *
     * OpenAI streams a sequence of `chat.completion.chunk` objects:
     *   - First chunk per choice: `delta.role: 'assistant'`
     *   - Text chunks: `delta.content: '...'`
     *   - Tool-call chunks: `delta.tool_calls[i] = { index, id?, type?, function: { name?, arguments?: '{partial...' } }`
     *   - Final chunk: `finish_reason: 'stop' | 'tool_calls' | 'length'`
     *   - Stream terminator: `data: [DONE]`
     *
     * Tool-call fragments arrive in arbitrary order across chunks. We
     * track them by `index` (per the spec, `id` is set only on the first
     * fragment for that tool call).
     */
    protected async consumeStream(
        body: ReadableStream<Uint8Array>,
        opts: StreamOptions,
    ): Promise<void> {
        // toolCallsByIndex[i] is the accumulated state for tool call `i`.
        const toolCallsByIndex = new Map<
            number,
            { id: string; name: string; argsBuffer: string; emittedStart: boolean }
        >();
        let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn';
        let terminated = false;

        // OpenAI emits a final chunk with `choices: []` and a populated
        // `usage: { prompt_tokens, completion_tokens, total_tokens }`
        // when `stream_options.include_usage: true` is set on the request.
        // That chunk arrives AFTER the chunk carrying finish_reason, so
        // we capture it lazily and emit `done` only on stream end (or
        // when the usage chunk arrives — whichever is later). Build 86 /
        // OWASP LLM10 observability extension.
        let usage: TokenUsage | undefined;
        const emitDone = (): void => {
            if (terminated) return;
            opts.onChunk({ type: 'done', stopReason, usage });
            terminated = true;
        };

        await consumeJsonSSEStream<OpenAIChunk>(body, (evt) => {
            if (terminated) return;

            // Usage chunk (always after finish_reason chunk when
            // include_usage=true). Capture and DEFER the done emit to
            // the end-of-stream sentinel below so we don't double-emit.
            if (evt?.usage && (!evt.choices || evt.choices.length === 0)) {
                usage = {
                    inputTokens: typeof evt.usage.prompt_tokens === 'number' ? evt.usage.prompt_tokens : 0,
                    outputTokens: typeof evt.usage.completion_tokens === 'number' ? evt.usage.completion_tokens : 0,
                };
                return;
            }

            const choice = (evt?.choices ?? [])[0];
            if (!choice) return;

            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content.length > 0) {
                opts.onChunk({ type: 'text_delta', text: markVisible(delta.content) });
            }

            if (Array.isArray(delta.tool_calls)) {
                for (const tcDelta of delta.tool_calls) {
                    const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
                    let tc = toolCallsByIndex.get(idx);
                    if (!tc) {
                        tc = { id: '', name: '', argsBuffer: '', emittedStart: false };
                        toolCallsByIndex.set(idx, tc);
                    }
                    if (typeof tcDelta.id === 'string' && tcDelta.id) tc.id = tcDelta.id;
                    if (tcDelta.function?.name) tc.name = tcDelta.function.name;
                    if (typeof tcDelta.function?.arguments === 'string') {
                        tc.argsBuffer += tcDelta.function.arguments;
                    }
                    if (!tc.emittedStart && tc.id && tc.name) {
                        tc.emittedStart = true;
                        opts.onChunk({
                            type: 'tool_use_start',
                            toolName: markVisible(tc.name),
                            toolUseId: markVisible(tc.id),
                        });
                    }
                    if (tc.emittedStart && typeof tcDelta.function?.arguments === 'string') {
                        opts.onChunk({
                            type: 'tool_use_args_delta',
                            toolUseId: markVisible(tc.id),
                            argsDelta: markVisible(tcDelta.function.arguments),
                        });
                    }
                }
            }

            if (choice.finish_reason) {
                stopReason = mapOpenAIStopReason(choice.finish_reason);
                if (stopReason === 'tool_use') {
                    toolCallsByIndex.forEach((tc) => {
                        if (!tc.id || !tc.emittedStart) return;
                        let parsed: Record<string, unknown> = {};
                        try {
                            parsed = tc.argsBuffer.length > 0
                                ? (JSON.parse(tc.argsBuffer) as Record<string, unknown>)
                                : {};
                        } catch {
                            parsed = {};
                        }
                        opts.onChunk({
                            type: 'tool_use_complete',
                            toolUseId: markVisible(tc.id),
                            args: markVisible(parsed),
                        });
                    });
                }
                // Don't emit done here — wait for the trailing usage
                // chunk (or stream end) so the audit pipeline gets
                // vendor-reported token counts. Stream-end fallback
                // below catches both the include_usage=true and
                // legacy-no-usage cases uniformly.
            }
        }, opts.abortSignal);

        emitDone();
    }
}

const mapOpenAIStopReason = (
    r: string,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' => {
    if (r === 'tool_calls') return 'tool_use';
    if (r === 'length') return 'max_tokens';
    if (r === 'function_call') return 'tool_use'; // legacy
    return 'end_turn';
};

const toOpenAIRequest = (
    payload: { messages: VendorMessage[]; tools: VendorToolDef[] },
    model: string,
    maxTokens: number,
): OpenAIChatRequest => {
    const messages: OpenAIMessage[] = [];

    for (const m of payload.messages) {
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            messages.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.args || '{}' },
                })),
            });
        } else if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
            // OpenAI requires one tool message per tool_call_id. The
            // optional trailing user content (rare) goes in a separate
            // user message after.
            for (const tr of m.toolResults) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tr.toolUseId,
                    content: tr.summary,
                });
            }
            if (m.content && m.content.trim().length > 0) {
                messages.push({ role: 'user', content: m.content });
            }
        } else {
            messages.push({ role: m.role, content: m.content });
        }
    }

    const tools: OpenAITool[] = payload.tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
        },
    }));

    return {
        model,
        messages,
        max_tokens: maxTokens,
        stream: true,
        // Build 86 (LLM10 observability) — opt in to the trailing usage
        // chunk so the audit pipeline records vendor-reported token
        // counts and the cost estimator can compute spend.
        stream_options: { include_usage: true },
        tools: tools.length > 0 ? tools : undefined,
    };
};

const safeReadBody = async (response: Response): Promise<string> => {
    try {
        return (await response.text()).slice(0, 500);
    } catch {
        return '<no body>';
    }
};

// ----- OpenAI wire format types -----

interface OpenAIChatRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens: number;
    stream: boolean;
    stream_options?: { include_usage: boolean };
    tools?: OpenAITool[];
}

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

interface OpenAIChunk {
    choices?: Array<{
        delta?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason?: string;
    }>;
    /** Present only on the trailing chunk when
     *  `stream_options.include_usage: true`. The chunk's `choices` array
     *  is empty in this case. */
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}
