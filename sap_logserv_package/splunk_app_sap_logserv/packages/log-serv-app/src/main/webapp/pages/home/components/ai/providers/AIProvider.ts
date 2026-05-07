import { ChunkEvent, Message, ToolDef } from '../types';

/**
 * AIProvider — the single interface every vendor adapter implements.
 *
 * Phase A ships only the interface plus a MockProvider stub. Real
 * provider implementations (Anthropic, OpenAI, Bedrock, Azure OpenAI,
 * Ollama) land in Phase D and Phase F.
 *
 * The privacy posture booleans on the descriptor must be set by the
 * admin during configuration based on what they have ACTUALLY
 * negotiated with the vendor — we do not infer or guess. They are
 * surfaced verbatim in the user-visible privacy banner (§6.5 of the
 * design doc).
 */

export interface ModelDescriptor {
    /** Vendor model ID, e.g., 'claude-opus-4-7' or 'gpt-4o-2024-11-20'. */
    id: string;
    /** Human-readable label for the config UI dropdown. */
    label: string;
    /** Maximum context window in tokens (informational). */
    contextWindow: number;
    /** Whether this model supports tool use (almost all do; flag for the rare exception). */
    supportsTools: boolean;
}

export interface PrivacyPosture {
    /** Vendor confirms our prompts will not be used for model training. */
    noTraining: boolean;
    /** Vendor confirms zero data retention beyond request lifetime. */
    zeroRetention: boolean;
    /** Days vendor retains prompts for abuse review (0 if zeroRetention=true). */
    abuseLoggingDays: number;
    /** Free-form note (e.g., "Bedrock platform-level guarantee, no addendum needed"). */
    notes?: string;
}

export interface StreamOptions {
    messages: ReadonlyArray<Message>;
    tools: ReadonlyArray<ToolDef>;
    /** Vendor-specific model ID (must be one of `provider.models[].id`). */
    model: string;
    /** Called for each ChunkEvent as the stream progresses. */
    onChunk: (chunk: ChunkEvent) => void;
    /** AbortSignal to cancel an in-flight stream. */
    abortSignal: AbortSignal;
    /** Maximum tokens the AI may generate this turn. Defaults to 4096. */
    maxTokens?: number;
}

export interface ConfigValidation {
    ok: boolean;
    /** When ok=false, human-readable reason. */
    reason?: string;
}

export interface AIProvider {
    /** Stable identifier (e.g., 'anthropic', 'openai', 'bedrock', 'ollama'). */
    readonly name: string;
    /** Human-readable label for the config UI. */
    readonly label: string;
    /** Models this provider exposes to the user. */
    readonly models: ReadonlyArray<ModelDescriptor>;
    /** Vendor-confirmed privacy posture. Set during admin config. */
    readonly privacyPosture: PrivacyPosture;
    /**
     * Stream a chat completion. The implementation MUST construct its
     * outbound payload via `buildOutboundPayload()` from `outboundGuard.ts`
     * — that is the only path through which content is allowed to leave
     * the browser to the vendor.
     */
    stream(opts: StreamOptions): Promise<void>;
    /**
     * Validate that the provider's configuration (API key, endpoint,
     * region, etc.) is functional. Called once at admin save time and
     * once on app load. Should be cheap (e.g., GET /v1/models).
     */
    validateConfig(): Promise<ConfigValidation>;
}
