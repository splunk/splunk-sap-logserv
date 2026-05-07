/**
 * v0.0.5.0 stripped variant — vendor-specific provider implementations
 * (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock) and the supporting
 * SSE / event-translator / credentials modules have been physically
 * removed from the source. Only the AIProvider interface, the no-op
 * MockProvider, and the outboundGuard defense layer remain.
 *
 * The hook (`useAIAssistant`) does not call any provider in this
 * variant — `sendUserMessage` is a stub that emits a system_notice
 * and returns. `runCannedPrompt` dispatches via MCP and never touches
 * a vendor.
 */

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

import { MockProvider } from './MockProvider';
import { AIProvider } from './AIProvider';

export type ProviderName = 'mock';

/**
 * Construct an AIProvider by name. v0.0.5.0 stripped variant only ships
 * the no-op MockProvider — every value resolves to it.
 */
export const createProviderByName = (_name: ProviderName): AIProvider => {
    return new MockProvider();
};
