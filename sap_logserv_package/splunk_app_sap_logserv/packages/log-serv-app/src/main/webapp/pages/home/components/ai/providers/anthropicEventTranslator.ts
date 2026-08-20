import { ChunkEvent, TokenUsage } from '../types/ChunkEvent';
import { markVisible } from '../types';

/**
 * Anthropic streaming event shape (subset used by AnthropicProvider and
 * BedrockProvider). Both endpoints emit identical event payloads — only
 * the transport differs (SSE for direct API, binary event-stream for
 * Bedrock InvokeModelWithResponseStream).
 */
export interface AnthropicStreamEvent {
    type: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string; input?: unknown };
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
    /** message_start: `message.usage` carries `input_tokens`,
     *  `cache_creation_input_tokens`, `cache_read_input_tokens` (and a
     *  small `output_tokens` placeholder of typically 1).
     *  message_delta: top-level `usage.output_tokens` is the FINAL
     *  cumulative output count for the stream. */
    message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } & Record<string, unknown>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    error?: { type?: string; message?: string };
}

/**
 * Per-stream translator state. Caller constructs once before the stream
 * begins, mutates it during translation, and reads `stopReason` /
 * `terminated` afterward.
 */
export interface AnthropicTranslatorState {
    /** Per-block accumulator for tool_use content blocks. Anthropic
     *  emits `input_json_delta` fragments that must be concatenated
     *  and JSON.parsed at content_block_stop. */
    blocks: Map<
        number,
        { type: 'text' | 'tool_use'; toolUseId?: string; toolName?: string; argsBuffer: string }
    >;
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    /** True once `message_stop` or `error` was seen — caller can break. */
    terminated: boolean;
    /** Accumulated token usage for the stream. `inputTokens` is set
     *  from `message_start.message.usage.input_tokens`. `outputTokens`
     *  is set from each `message_delta.usage.output_tokens` (cumulative
     *  per Anthropic's contract — last value wins). Cache fields are
     *  read once from `message_start`. Emitted on the `done` chunk at
     *  `message_stop`. Build 82 / LLM10 observability. */
    usage: TokenUsage;
}

export const newTranslatorState = (): AnthropicTranslatorState => ({
    blocks: new Map(),
    stopReason: 'end_turn',
    terminated: false,
    usage: { inputTokens: 0, outputTokens: 0 },
});

/**
 * Translate one Anthropic stream event into zero-or-more ChunkEvents.
 *
 * Anthropic event types handled:
 *   - message_start            → (no chunk; metadata only)
 *   - content_block_start
 *      .content_block.type='text'      → (no chunk; init text block)
 *      .content_block.type='tool_use'  → tool_use_start
 *   - content_block_delta
 *      .delta.type='text_delta'        → text_delta
 *      .delta.type='input_json_delta'  → tool_use_args_delta + accumulate
 *   - content_block_stop      → for tool_use blocks: emit tool_use_complete
 *   - message_delta           → (capture stop_reason in state)
 *   - message_stop            → done (sets `terminated`)
 *   - error                   → error chunk (sets `terminated`)
 */
export const translateAnthropicEvent = (
    evt: AnthropicStreamEvent,
    state: AnthropicTranslatorState,
    onChunk: (c: ChunkEvent) => void,
): void => {
    if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string') return;

    switch (evt.type) {
        case 'message_start': {
            // Capture initial token usage. `input_tokens` is final at
            // this point (it's the prompt size). `output_tokens` here
            // is a small placeholder (typically 1); the real cumulative
            // value lands on each `message_delta`. Cache fields, when
            // present, indicate prompt-cache behavior for billing.
            const u = evt.message?.usage;
            if (u && typeof u === 'object') {
                if (typeof u.input_tokens === 'number') state.usage.inputTokens = u.input_tokens;
                if (typeof u.output_tokens === 'number') state.usage.outputTokens = u.output_tokens;
                if (typeof u.cache_read_input_tokens === 'number') {
                    state.usage.cachedInputTokens = u.cache_read_input_tokens;
                }
                if (typeof u.cache_creation_input_tokens === 'number') {
                    state.usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
                }
            }
            return;
        }

        case 'content_block_start': {
            const idx = typeof evt.index === 'number' ? evt.index : 0;
            const cb = evt.content_block ?? {};
            if (cb.type === 'tool_use') {
                const toolUseId = String(cb.id ?? `toolu_${idx}`);
                const toolName = String(cb.name ?? '');
                state.blocks.set(idx, {
                    type: 'tool_use',
                    toolUseId,
                    toolName,
                    argsBuffer: '',
                });
                onChunk({
                    type: 'tool_use_start',
                    toolName: markVisible(toolName),
                    toolUseId: markVisible(toolUseId),
                });
            } else {
                state.blocks.set(idx, { type: 'text', argsBuffer: '' });
            }
            return;
        }

        case 'content_block_delta': {
            const idx = typeof evt.index === 'number' ? evt.index : 0;
            const block = state.blocks.get(idx);
            const delta = evt.delta ?? {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                onChunk({ type: 'text_delta', text: markVisible(delta.text) });
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                if (block && block.type === 'tool_use') {
                    block.argsBuffer += delta.partial_json;
                    onChunk({
                        type: 'tool_use_args_delta',
                        toolUseId: markVisible(block.toolUseId ?? ''),
                        argsDelta: markVisible(delta.partial_json),
                    });
                }
            }
            return;
        }

        case 'content_block_stop': {
            const idx = typeof evt.index === 'number' ? evt.index : 0;
            const block = state.blocks.get(idx);
            if (block && block.type === 'tool_use' && block.toolUseId) {
                const argsText = block.argsBuffer.length > 0 ? block.argsBuffer : '{}';
                let parsed: Record<string, unknown> = {};
                try {
                    parsed = JSON.parse(argsText) as Record<string, unknown>;
                } catch {
                    parsed = {};
                }
                onChunk({
                    type: 'tool_use_complete',
                    toolUseId: markVisible(block.toolUseId),
                    args: markVisible(parsed),
                });
            }
            state.blocks.delete(idx);
            return;
        }

        case 'message_delta': {
            const sr = evt.delta?.stop_reason;
            if (sr === 'end_turn' || sr === 'tool_use' || sr === 'max_tokens' || sr === 'stop_sequence') {
                state.stopReason = sr;
            }
            // Anthropic emits cumulative output_tokens here on each
            // message_delta. Last value before message_stop is the
            // final stream-wide count.
            if (evt.usage && typeof evt.usage.output_tokens === 'number') {
                state.usage.outputTokens = evt.usage.output_tokens;
            }
            return;
        }

        case 'message_stop':
            onChunk({ type: 'done', stopReason: state.stopReason, usage: state.usage });
            state.terminated = true;
            return;

        case 'error': {
            const errInfo = (evt.error ?? {}) as { type?: string; message?: string };
            onChunk({
                type: 'error',
                error: {
                    code: errInfo.type ?? 'anthropic_error',
                    message: errInfo.message ?? 'Unknown Anthropic error',
                },
            });
            state.terminated = true;
            return;
        }

        case 'ping':
        default:
            return;
    }
};

/**
 * Build the Anthropic Messages API request body from our outbound payload
 * (already privacy-checked). Used by both AnthropicProvider (direct API)
 * and BedrockProvider (Anthropic-on-Bedrock).
 *
 * Bedrock uses identical body except:
 *   - `model` is in the URL, not the body — caller passes `null`
 *   - `stream` field is omitted (stream is implicit in the endpoint)
 *   - `anthropic_version: 'bedrock-2023-05-31'` field is added
 */
export const buildAnthropicMessagesBody = (
    payload: { messages: AnthropicVendorMsg[]; tools: AnthropicVendorToolDef[] },
    model: string | null,
    maxTokens: number,
    bedrockMode = false,
): Record<string, unknown> => {
    const systemParts: string[] = [];
    const messages: AnthropicMessage[] = [];

    for (const m of payload.messages) {
        if (m.role === 'system') {
            systemParts.push(m.content);
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            const content: AnthropicContentBlock[] = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                let parsedArgs: unknown = {};
                try {
                    parsedArgs = tc.args ? JSON.parse(tc.args) : {};
                } catch {
                    parsedArgs = {};
                }
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: parsedArgs,
                });
            }
            messages.push({ role: 'assistant', content });
        } else if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
            const content: AnthropicContentBlock[] = [];
            for (const tr of m.toolResults) {
                content.push({
                    type: 'tool_result',
                    tool_use_id: tr.toolUseId,
                    content: tr.summary,
                    is_error: tr.isError === true,
                });
            }
            if (m.content && m.content.trim().length > 0) {
                content.push({ type: 'text', text: m.content });
            }
            messages.push({ role: 'user', content });
        } else {
            messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
        }
    }

    const tools = payload.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Record<string, unknown>,
    }));

    const body: Record<string, unknown> = {
        max_tokens: maxTokens,
        messages,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        tools: tools.length > 0 ? tools : undefined,
    };

    if (bedrockMode) {
        body.anthropic_version = 'bedrock-2023-05-31';
    } else {
        body.model = model;
        body.stream = true;
    }

    return body;
};

// ----- Type aliases (avoid circular imports with outboundGuard) -----

interface AnthropicVendorMsg {
    role: 'system' | 'user' | 'assistant';
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: string }>;
    toolResults?: Array<{ toolUseId: string; summary: string; isError?: boolean }>;
}

interface AnthropicVendorToolDef {
    name: string;
    description: string;
    inputSchema: object;
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
