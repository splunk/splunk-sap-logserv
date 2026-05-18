// =============================================================================
// LLM provider barrel — TEMPLATES-ONLY VARIANT (v0.0.5.0)
// =============================================================================
//
// This is the v0.0.5.0 "templates-only" build: the LLM provider implementations
// (Anthropic, OpenAI, Azure OpenAI, Bedrock) have been physically removed from
// source so that no LLM dispatch can ever occur regardless of build flags or
// runtime config. Only the MockProvider remains, which produces deterministic
// canned responses for the canned-prompt path.
//
// The corresponding v0.1.1 build of this file re-exports four real LLM
// providers + SSE / Anthropic-event-translator helpers — see v0.1.1 source
// for the full version. v0.0.5.0 is the source-of-truth for the
// public-publishable variant; this file MUST NOT import or re-export any of
// the six LLM-only files:
//
//   - AnthropicProvider.ts
//   - OpenAIProvider.ts
//   - AzureOpenAIProvider.ts
//   - BedrockProvider.ts
//   - anthropicEventTranslator.ts
//   - sseUtils.ts
//
// `credentials.ts` IS retained — it's a generic Splunk storage/passwords
// utility used by `MCPClient.ts` to read the optional MCP bearer token and
// by the audit forwarder to read the HEC token. Not LLM-specific.
//
// Belt-and-suspenders enforcement of the templates-only mode (any one of these
// three layers prevents an LLM call independently of the others):
//
//   1. Compile-time: buildFlags.TEMPLATES_ONLY === true (webpack DefinePlugin
//      replaces references with the literal `true`; dead-code elimination
//      removes the would-be vendor-dispatch branches from the bundle).
//   2. Runtime: ai_assistant_settings.conf `templates_only_mode = true` is the
//      default. Admin-visible but locked from end users via metadata ACL.
//   3. Physical: the seven LLM provider files are absent from source. Even if
//      a future code change accidentally re-introduces a dispatch path, there
//      is no provider to dispatch to.

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

export {
    readSecret,
    requireSecret,
    clearCredentialCache,
    CredentialReadError,
    CredentialMissingError,
} from './credentials';
export type { ReadSecretOptions } from './credentials';

import { MockProvider } from './MockProvider';
import { AIProvider } from './AIProvider';

// Provider name union — kept in sync with the v0.1.1 ai_assistant_settings.conf
// vocabulary so that any setting saved on a v0.1.1 install and migrated here
// still parses cleanly. All non-mock names route to MockProvider in this build.
export type ProviderName = 'mock' | 'anthropic' | 'openai' | 'azure_openai' | 'bedrock' | 'ollama';

/**
 * Templates-only factory: ALL provider names route to MockProvider.
 *
 * In v0.1.1 this factory dispatches by name to the relevant LLM provider
 * implementation. In v0.0.5.0 the LLM provider files are physically absent
 * from source, so we collapse the dispatch to MockProvider for every input
 * name. Admin Settings UI is also gated to hide the Provider Credentials tab
 * + the provider/model picker — see AIAssistantSettings.tsx and ChatInput.tsx
 * for the TEMPLATES_ONLY-gated branches.
 */
export const createProviderByName = (_name: ProviderName): AIProvider => {
    return new MockProvider();
};
