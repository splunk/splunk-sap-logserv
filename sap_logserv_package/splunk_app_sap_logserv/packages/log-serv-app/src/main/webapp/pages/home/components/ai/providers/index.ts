export type {
    AIProvider,
    ModelDescriptor,
    PrivacyPosture,
    StreamOptions,
    ConfigValidation,
} from './AIProvider';

export type {
    VendorPayload,
    VendorMessage,
    VendorToolCall,
    VendorToolResult,
    VendorToolDef,
} from './outboundGuard';
export {
    buildOutboundPayload,
    scanForForbiddenKeys,
    OutboundGuardError,
    FORBIDDEN_FIELD_NAMES,
} from './outboundGuard';

export { MockProvider } from './MockProvider';

export { AnthropicProvider } from './AnthropicProvider';
export type { AnthropicProviderOptions } from './AnthropicProvider';

export { OpenAIProvider, filterOpenAIModels } from './OpenAIProvider';
export type { OpenAIProviderOptions } from './OpenAIProvider';

export { AzureOpenAIProvider } from './AzureOpenAIProvider';
export type { AzureOpenAIProviderOptions } from './AzureOpenAIProvider';

export { BedrockProvider } from './BedrockProvider';
export type { BedrockProviderOptions } from './BedrockProvider';

export {
    readSecret,
    requireSecret,
    clearCredentialCache,
    CredentialReadError,
    CredentialMissingError,
} from './credentials';
export type { ReadSecretOptions } from './credentials';

export { consumeSSEStream, consumeJsonSSEStream } from './sseUtils';
export type { SSEPayloadHandler, SSEJsonHandler } from './sseUtils';

export {
    buildAnthropicMessagesBody,
    newTranslatorState,
    translateAnthropicEvent,
} from './anthropicEventTranslator';
export type { AnthropicStreamEvent, AnthropicTranslatorState } from './anthropicEventTranslator';

import { MockProvider } from './MockProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { AzureOpenAIProvider } from './AzureOpenAIProvider';
import { BedrockProvider } from './BedrockProvider';
import { AIProvider } from './AIProvider';

export type ProviderName = 'mock' | 'anthropic' | 'openai' | 'azure_openai' | 'bedrock' | 'ollama';

/**
 * Construct an AIProvider by name. Falls back to MockProvider for any
 * name that has no implementation yet (currently `ollama` — Phase F).
 *
 * Phase D wires four real providers; Phase F adds Ollama. Until then,
 * an `ollama` setting silently drops to MockProvider so the chat doesn't
 * break for users who picked it.
 */
export const createProviderByName = (name: ProviderName): AIProvider => {
    switch (name) {
        case 'anthropic':
            return new AnthropicProvider();
        case 'openai':
            return new OpenAIProvider();
        case 'azure_openai':
            return new AzureOpenAIProvider();
        case 'bedrock':
            return new BedrockProvider();
        case 'mock':
        case 'ollama': // Phase F — falls back to mock until OllamaProvider lands
        default:
            return new MockProvider();
    }
};
