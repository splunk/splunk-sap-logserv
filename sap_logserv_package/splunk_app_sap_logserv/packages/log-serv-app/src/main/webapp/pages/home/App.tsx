import React, { useCallback, useEffect, useState } from 'react';
import { HashRouter } from 'react-router-dom';
// `username` is a runtime constant exposed by Splunk Web's `window.$C`
// global, populated at page load by the Splunk Web frontend. Empty
// string when not running inside Splunk Web (tests, local dev).
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { TimeRangeProvider } from './state/TimeRangeProvider';
import { AIAssistantProvider } from './state/AIAssistantProvider';
import {
    AIAssistantConfig,
    DEFAULT_AI_ASSISTANT_CONFIG,
    loadAIAssistantConfig,
} from './state/AIAssistantConfig';
import AppShell from './components/AppShell';
import {
    setAuditForwarderConfig,
    setLocalAuditIndex,
} from './components/ai/audit';
import { readCredentialClear } from './utils/passwordsApi';
import { migrateConfFileSettingsToKvStore } from './utils/aiConfigApi';
import { migrateConfFileAcksToKvStore } from './utils/telemetryConfApi';

/**
 * App root.
 *
 * The AI Assistant config is loaded asynchronously from
 * `ai_assistant_settings.conf` at mount. Until the load resolves, the
 * app renders with `DEFAULT_AI_ASSISTANT_CONFIG` (AI Assistant button
 * hidden — same as a fresh install). Once the conf arrives, the
 * AIAssistantProvider remounts with the admin's chosen provider and
 * AppShell switches the AI Assistant button on if `enabled = true`.
 *
 * The AIAssistantProvider is mounted unconditionally so Phase A/B/C
 * code (audit, type guards, MCP probe) can run regardless of whether
 * the feature is enabled. The provider is cheap (zero outbound traffic
 * on its own — just allocates the React context).
 */
const App: React.FC = () => {
    const [aiConfig, setAiConfig] = useState<AIAssistantConfig>(DEFAULT_AI_ASSISTANT_CONFIG);

    /**
     * Load the AI Assistant config from `ai_assistant_settings.conf`
     * and apply it to:
     *
     *  1. App-level state (`aiConfig`) — drives whether the AI
     *     Assistant button + side panel render in `AppShell`.
     *  2. AuditWriter module state (forwarder config) — drives
     *     dual-write to the HEC endpoint configured in Settings.
     *
     * Called once at mount; also called by `refreshAIConfig` after
     * the Settings page successfully persists a change so downstream
     * UI reflects the new posture immediately (no page reload
     * required).
     *
     * The HEC token lives in passwords.conf; admin-only readable. For
     * non-admin users the read returns empty string, and forwarding
     * silently no-ops (audit events still hit the local index).
     * Build 98 / 99 / 100 / 101.
     */
    const applyAIConfig = useCallback(async (cfg: AIAssistantConfig): Promise<void> => {
        setAiConfig(cfg);
        // Update the AuditWriter's destination-index name. Subsequent
        // flush() / postOneOff() calls target the new index. Empty /
        // missing values fall back to the default `ai_assistant_audit`
        // (handled inside `setLocalAuditIndex`).
        setLocalAuditIndex(cfg.auditIndexName);
        const hecToken = cfg.auditForwarderEnabled
            ? await readCredentialClear(
                  'logserv_ai_assistant_forwarder',
                  'hec_token',
              )
            : '';
        setAuditForwarderConfig({
            enabled: cfg.auditForwarderEnabled,
            url: cfg.auditForwarderUrl,
            hecToken,
            index: cfg.auditForwarderIndex,
            source: cfg.auditForwarderSource,
        });
    }, []);

    /**
     * Re-read `ai_assistant_settings.conf` and re-apply. Called by
     * the Settings page after `writeAIConfig` succeeds, so toggling
     * `enabled` (or any other config field) takes effect immediately
     * without a page reload — the AI Assistant button vanishes the
     * moment the admin disables the feature, the privacy banner
     * updates, the forwarder config refreshes, etc.
     *
     * `loadAIAssistantConfig` reads through `aiConfigApi.readAIConfig`
     * which has an in-process cache; the cache is invalidated by
     * `writeAIConfig` itself (clearAIConfigCache) so this read sees
     * the freshly-written values. Build 101 / session 022.
     */
    const refreshAIConfig = useCallback(async (): Promise<void> => {
        const cfg = await loadAIAssistantConfig();
        await applyAIConfig(cfg);
    }, [applyAIConfig]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            /* Session 042 / Option D — one-shot migration helpers copy
             * pre-migration conf-file values into KV Store on first
             * load. Idempotent: subsequent loads find the KV Store rows
             * populated and no-op. Awaited BEFORE the initial config
             * read so the read sees the migrated values immediately on
             * the first post-upgrade page load. Both are best-effort —
             * failures don't block the UI. */
            await Promise.all([
                migrateConfFileSettingsToKvStore(),
                migrateConfFileAcksToKvStore(),
            ]);
            if (cancelled) return;
            const cfg = await loadAIAssistantConfig();
            if (cancelled) return;
            await applyAIConfig(cfg);
        })();
        return () => {
            cancelled = true;
        };
    }, [applyAIConfig]);

    return (
        <TimeRangeProvider>
            <AIAssistantProvider
                providerName={aiConfig.provider}
                defaultModel={aiConfig.defaultModel}
                user={typeof splunkUsername === 'string' ? splunkUsername : ''}
            >
                <HashRouter>
                    <AppShell
                        aiAssistantEnabled={aiConfig.enabled}
                        aiAssistantTemplatesOnlyMode={aiConfig.templatesOnlyMode}
                        aiAssistantTier={aiConfig.tier}
                        aiAssistantMcpRequired={aiConfig.mcpRequired}
                        aiAssistantRateLimitPerHour={aiConfig.rateLimitPerHour}
                        aiAssistantToolCallsPerSessionCap={aiConfig.toolCallsPerSessionCap}
                        aiAssistantDailySpendCapUsd={aiConfig.dailySpendCapUsd}
                        aiAssistantTier2PiiRedaction={aiConfig.tier2PiiRedaction}
                        aiAssistantTier2RedactHostnames={aiConfig.tier2RedactHostnames}
                        aiAssistantPowerUserRoles={aiConfig.powerUserRoles}
                        onAIConfigSaved={refreshAIConfig}
                    />
                </HashRouter>
            </AIAssistantProvider>
        </TimeRangeProvider>
    );
};

export default App;
