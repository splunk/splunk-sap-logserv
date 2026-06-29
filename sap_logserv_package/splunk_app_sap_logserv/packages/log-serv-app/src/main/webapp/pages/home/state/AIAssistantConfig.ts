/**
 * AI Assistant feature configuration.
 *
 * Reads org-wide defaults from `ai_assistant_settings.conf` via
 * `utils/aiConfigApi.ts`. Admins manage these values from the
 * Settings page (`#/settings` → AI Assistant → General); the
 * conf is the single source of truth for `enabled`, `provider`,
 * `default_model`, `tier`, `mcp_required`, and `mcp_server_url`.
 *
 * Per-user settings:
 *   - The chat panel's model picker writes to sessionStorage (per-tab,
 *     constrained to the active provider's `models[]` — see
 *     `AIAssistantProvider`).
 *   - There are no per-user feature toggles. The previously supported
 *     URL flags (`?aiAssistant=on`, `?aiProvider=...`, `?aiModel=...`,
 *     `?aiMCPRequired=...`) were retired when the admin Settings page
 *     became the source of truth.
 */

import { PrivacyTier, ProviderName, readAIConfig } from '../utils/aiConfigApi';

export interface AIAssistantConfig {
    /** Master switch — when false, all AI Assistant UI is hidden. */
    enabled: boolean;
    /** Runtime templates-only mode. When true, the LLM-driven free-form
     *  path is disabled at runtime: chat input read-only, Send button
     *  disabled, model picker + Power Mode toggle hidden, Provider
     *  Credentials Settings tab hidden. Predefined-prompt path + MCP +
     *  audit log stay fully active. Replaces the compile-time
     *  TEMPLATES_ONLY build flag with admin-controlled runtime config. */
    templatesOnlyMode: boolean;
    /** Active provider name. Drives the chat panel's model picker. */
    provider: ProviderName;
    /** Admin-chosen default model for the active provider. The chat
     *  panel's per-user model picker overrides this within the same
     *  provider's `models[]`. */
    defaultModel: string;
    /** Privacy tier (0/1/2). Drives the privacy banner in the chat. */
    tier: PrivacyTier;
    /** When true (default), the MCP health probe gates the chat behind
     *  the setup wizard. When false, chat operates in MCP-less mode
     *  (streaming-only, no tool dispatch). */
    mcpRequired: boolean;
    /** Per-user free-form prompt rate limit (rolling 1-hour window).
     *  0 = disabled. Maps to OWASP LLM10. Build 80 / session 019. */
    rateLimitPerHour: number;
    /** Per-chat-session cap on total MCP tool dispatches across all
     *  messages. 0 = disabled. Maps to OWASP LLM06. Build 88 / session 020. */
    toolCallsPerSessionCap: number;
    /** Per-user daily vendor spend cap in USD (resets at local
     *  midnight). 0 = disabled. Maps to OWASP LLM10. Build 89. */
    dailySpendCapUsd: number;
    /** Tier 2 PII column redaction. When true (default), Tier 2
     *  categorical aggregates redact identifier-class column values
     *  (user / email / *_ip / mac / account) before they cross the
     *  privacy boundary. Maps to OWASP LLM02. Build 94 / session 022. */
    tier2PiiRedaction: boolean;
    /** When true, also redact host / hostname columns. Default false.
     *  Build 94 / session 022. */
    tier2RedactHostnames: boolean;
    /** Local Splunk index that receives every audit event the AI Assistant
     *  writes. Default `ai_assistant_audit` matches the LogServ Index App's
     *  default indexes.conf and the `sap_logserv_audit_idx_macro` definition.
     *  Customers who rename the audit index must also update the macro
     *  definition for in-app + user-written queries to find the events. */
    auditIndexName: string;
    /** When true, every audit event is dual-written to the configured
     *  HEC endpoint for tamper-evidence. Build 98 / session 022. */
    auditForwarderEnabled: boolean;
    /** Destination HEC base URL. Build 98. */
    auditForwarderUrl: string;
    /** Optional remote index name. Build 98. */
    auditForwarderIndex: string;
    /** Source field stamped on forwarded events. Build 98. */
    auditForwarderSource: string;
    /** Comma-separated list of Splunk role names whose members get the
     *  AI Assistant Power Mode toggle. Empty (default) hides the toggle
     *  for everyone. Stored as a CSV string so a Splunk-conf round-trip
     *  preserves it cleanly; parsed to `string[]` at consumption sites
     *  via `parsePowerUserRoles()`. Build 166 / session 028. */
    powerUserRoles: string;
}

/** Parse the CSV-encoded `powerUserRoles` config into a deduped, trimmed
 *  array of role names. Empty input → empty array. */
export const parsePowerUserRoles = (csv: string): string[] => {
    if (!csv) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of csv.split(',')) {
        const t = part.trim();
        if (t.length > 0 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
};

/** Safe defaults used while the conf is loading or if the read fails.
 *  Mirrors `default/ai_assistant_settings.conf`. */
export const DEFAULT_AI_ASSISTANT_CONFIG: AIAssistantConfig = {
    enabled: false,
    templatesOnlyMode: false,
    provider: 'mock',
    defaultModel: 'mock-fast',
    tier: 1,
    mcpRequired: true,
    rateLimitPerHour: 30,
    toolCallsPerSessionCap: 100,
    dailySpendCapUsd: 50.0,
    tier2PiiRedaction: true,
    tier2RedactHostnames: false,
    auditIndexName: 'ai_assistant_audit',
    auditForwarderEnabled: false,
    auditForwarderUrl: '',
    auditForwarderIndex: '',
    auditForwarderSource: 'logserv_ai_assistant_remote',
    powerUserRoles: '',
};

/**
 * Load the AI Assistant config from `ai_assistant_settings.conf`.
 *
 * The call is async because the underlying REST read is async; on
 * failure (network error, fresh install before the conf exists, etc.)
 * the safe defaults are returned. Callers should typically render with
 * `DEFAULT_AI_ASSISTANT_CONFIG` first and update once the load resolves.
 */
export const loadAIAssistantConfig = async (): Promise<AIAssistantConfig> => {
    const stored = await readAIConfig();
    return {
        enabled: stored.enabled,
        templatesOnlyMode: stored.templates_only_mode,
        provider: stored.provider,
        defaultModel: stored.default_model,
        tier: stored.tier,
        mcpRequired: stored.mcp_required,
        rateLimitPerHour: stored.rate_limit_per_hour,
        toolCallsPerSessionCap: stored.tool_calls_per_session_cap,
        dailySpendCapUsd: stored.daily_spend_cap_usd,
        tier2PiiRedaction: stored.tier2_pii_redaction,
        tier2RedactHostnames: stored.tier2_redact_hostnames,
        auditIndexName: stored.audit_index_name,
        auditForwarderEnabled: stored.audit_forwarder_enabled,
        auditForwarderUrl: stored.audit_forwarder_url,
        auditForwarderIndex: stored.audit_forwarder_index,
        auditForwarderSource: stored.audit_forwarder_source,
        powerUserRoles: stored.power_user_roles,
    };
};
