import { AIProvider, ConfigValidation, ModelDescriptor, PrivacyPosture, StreamOptions } from './AIProvider';
import { buildOutboundPayload } from './outboundGuard';
import { markVisible } from '../types';

/**
 * MockProvider — Phase A stub.
 *
 * Doesn't actually call any vendor. Constructs the outbound payload
 * (which exercises the guard) and then streams a canned response.
 *
 * Two purposes:
 *   1. Lets us prove end-to-end that the privacy guard catches mistakes
 *      before they leave the browser, even with no real vendor wired up.
 *   2. Lets the UI work (Phase C) be developed against a real
 *      AIProvider implementation that doesn't require API keys.
 *
 * Replaced in Phase D (Anthropic, OpenAI, Bedrock, Azure OpenAI) and
 * Phase F (Ollama).
 */

const MOCK_MODELS: ReadonlyArray<ModelDescriptor> = [
    {
        id: 'mock-fast',
        label: 'Mock — Fast',
        contextWindow: 8000,
        supportsTools: true,
    },
    {
        id: 'mock-deep',
        label: 'Mock — Deep',
        contextWindow: 200000,
        supportsTools: true,
    },
];

const MOCK_POSTURE: PrivacyPosture = {
    noTraining: true,
    zeroRetention: true,
    abuseLoggingDays: 0,
    notes: 'MockProvider does not transmit anything; posture is symbolic.',
};

export class MockProvider implements AIProvider {
    readonly name = 'mock';
    readonly label = 'Mock (development only)';
    readonly models = MOCK_MODELS;
    readonly privacyPosture = MOCK_POSTURE;

    async stream(opts: StreamOptions): Promise<void> {
        // Even though we don't transmit, build the payload so the guard
        // runs. If a programmer accidentally puts forbidden data into a
        // message during dev, this will throw and surface the bug
        // before they wire up a real provider.
        buildOutboundPayload(opts.messages, opts.tools);

        // Canned streamed response. Each chunk is wrapped in a
        // setTimeout(0) so the consumer can observe streaming behavior.
        const cannedTokens = [
            'I am ',
            'a mock ',
            'AI provider. ',
            'No real model ',
            'was contacted. ',
            'The outbound guard ',
            'verified your payload ',
            'before this stream began.',
        ];

        for (const tok of cannedTokens) {
            if (opts.abortSignal.aborted) {
                opts.onChunk({
                    type: 'error',
                    error: { code: 'aborted', message: 'Stream aborted by caller.' },
                });
                return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            opts.onChunk({ type: 'text_delta', text: markVisible(tok) });
        }

        // Synthesize a plausible token usage report so the audit-event
        // pipeline has end-to-end coverage without needing a real
        // vendor. ~4 chars per token is the rough English heuristic.
        // Build 82 / OWASP LLM10 observability.
        const inboundChars = JSON.stringify(opts.messages).length;
        const outboundChars = cannedTokens.join('').length;
        opts.onChunk({
            type: 'done',
            stopReason: 'end_turn',
            usage: {
                inputTokens: Math.max(1, Math.round(inboundChars / 4)),
                outputTokens: Math.max(1, Math.round(outboundChars / 4)),
            },
        });
    }

    async validateConfig(): Promise<ConfigValidation> {
        return { ok: true };
    }

    /**
     * Mock model discovery — returns the static baseline PLUS one
     * discovered-only entry after a tick. Exercises the full discovery
     * pipeline (sanitize → KV Store cache → merge → picker/audit) with
     * no vendor key: after a refresh the picker shows 3 models instead
     * of 2, making the mechanism visibly verifiable on any install.
     * Session 079 / build 275.
     */
    async listModels(): Promise<ReadonlyArray<ModelDescriptor>> {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return [
            ...MOCK_MODELS,
            {
                id: 'mock-discovered',
                label: 'Mock — Discovered (via model discovery)',
                contextWindow: 128_000,
                supportsTools: true,
            },
        ];
    }
}
