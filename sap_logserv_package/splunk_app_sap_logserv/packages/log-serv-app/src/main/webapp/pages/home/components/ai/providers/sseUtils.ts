/**
 * SSE (Server-Sent Events) parsing utilities shared by Anthropic,
 * OpenAI, and Azure OpenAI providers (all use `data: <json>\n\n` framing).
 *
 * Bedrock has its own InvokeModelWithResponseStream chunked binary format
 * and does NOT use these helpers — see BedrockProvider for its parser.
 *
 * Implemented with callback-based push semantics (rather than async
 * generators) so the project can stay on `lib: es2017` without needing
 * downlevel iteration / Symbol.asyncIterator.
 */

export type SSEPayloadHandler = (payload: string) => void;
export type SSEJsonHandler<T> = (parsed: T) => void;

/**
 * Read a `ReadableStream<Uint8Array>` body to completion, invoking
 * `onPayload` for each `data:` event extracted from the SSE stream.
 *
 * Handles cross-chunk event boundaries and `\r\n\r\n` separators.
 * Drops `event:` / `id:` / `retry:` / comment lines silently — Anthropic
 * and OpenAI both put their event type in the JSON `type` field, so the
 * SSE event-name line is informational only.
 *
 * Throws `DOMException('Aborted')` if `abortSignal` fires.
 */
export const consumeSSEStream = async (
    stream: ReadableStream<Uint8Array>,
    onPayload: SSEPayloadHandler,
    abortSignal?: AbortSignal,
): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        while (true) {
            if (abortSignal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sepIdx: number;
            while ((sepIdx = nextEventSeparator(buffer)) !== -1) {
                const rawEvent = buffer.slice(0, sepIdx);
                buffer = buffer.slice(sepIdx + separatorLength(buffer, sepIdx));
                emitDataLines(rawEvent, onPayload);
            }
        }

        const trailing = buffer.trim();
        if (trailing.length > 0) emitDataLines(trailing, onPayload);
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // best-effort
        }
    }
};

const emitDataLines = (rawEvent: string, onPayload: SSEPayloadHandler): void => {
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
            const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
            dataLines.push(payload);
        }
        // event: / id: / retry: / comment lines are ignored
    }
    if (dataLines.length === 0) return;
    onPayload(dataLines.join('\n'));
};

const nextEventSeparator = (s: string): number => {
    const a = s.indexOf('\n\n');
    const b = s.indexOf('\r\n\r\n');
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
};

const separatorLength = (s: string, idx: number): number =>
    s.startsWith('\r\n\r\n', idx) ? 4 : 2;

/**
 * Convenience: parse SSE and try-decode each event payload as JSON,
 * invoking `onJson(parsed)`. Skips events whose payload is not valid
 * JSON (e.g., the OpenAI `[DONE]` sentinel) — caller recognizes
 * terminal events via the JSON's own `type` / `done` field, not via
 * a [DONE] callback.
 *
 * Returns when the stream ends OR when the OpenAI [DONE] marker fires.
 */
export const consumeJsonSSEStream = async <T = unknown>(
    stream: ReadableStream<Uint8Array>,
    onJson: SSEJsonHandler<T>,
    abortSignal?: AbortSignal,
): Promise<void> => {
    let doneSeen = false;
    await consumeSSEStream(
        stream,
        (payload) => {
            if (doneSeen) return;
            if (payload === '[DONE]') {
                doneSeen = true;
                return;
            }
            try {
                onJson(JSON.parse(payload) as T);
            } catch {
                // ignore malformed events — vendors occasionally inject keepalives
            }
        },
        abortSignal,
    );
};
