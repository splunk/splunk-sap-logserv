import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { Hidden, Message, MockProvider, AIProvider } from '../components/ai';
import { createProviderByName, ProviderName } from '../components/ai/providers';
import { ModelDescriptor } from '../components/ai/providers/AIProvider';
import {
    maybeRefreshModelsTtl,
    mergeModels,
    readModelCacheRow,
} from '../components/ai/modelDiscovery';
import { MCPClient } from '../components/ai/mcp/MCPClient';
import { MCPToolResult } from '../components/ai/mcp/MCPClient';
import { AuditWriter } from '../components/ai/audit/auditWriter';
import { AuditEvent } from '../components/ai/audit/auditTypes';
import { ChartPalette } from '../styles/chartPalettes';

const SESSION_KEY_SELECTED_MODEL = 'logserv.aiAssistant.selectedModel';
/** Per-tab Power Mode toggle state. Build 166 / session 028.
 *  Stored as `'1'` / `'0'` strings (not booleans) so a stale empty
 *  value falls through to "off" without ambiguity. */
const SESSION_KEY_POWER_MODE = 'logserv.aiAssistant.powerMode';

/**
 * AI Assistant conversation state — lives at the React root so the
 * conversation persists across dashboard navigation.
 *
 * Per design §6.2: "Conversation persists for the browser session
 * (closes on tab close — better privacy posture than localStorage)".
 *
 * Two collections of messages, kept deliberately separate:
 *
 *   `messages`        — the displayable chat (user msgs, AI msgs, tool
 *                        call cards, tool result placeholders). Drives
 *                        the chat UI directly.
 *
 *   `vendorMessages`  — the Visible-only subset that goes outbound to
 *                        the AI vendor on the next turn. Tool RESULTS
 *                        are NEVER in this list — only a Visible
 *                        summary string the AI itself produced or a
 *                        sanitize() output.
 */

export type DisplayMessageKind = 'user' | 'assistant_text' | 'tool_call' | 'tool_result' | 'system_notice' | 'guidance';

export interface DisplayMessage {
    /** Stable id for React keys + audit cross-references. */
    id: string;
    kind: DisplayMessageKind;
    /** Plain-text content for user/assistant_text messages. */
    text?: string;
    /** Tool call info for kind='tool_call'. */
    toolCall?: { toolUseId: string; toolName: string; args: Record<string, unknown>; spl?: string };
    /** Tool result for kind='tool_result' — Hidden, lives only in browser.
     *  `displayName` is the human-readable label for the right-pane panel
     *  title (e.g. saved-search name for splunk_run_saved_search; SPL
     *  preview for splunk_run_query). Falls back to "Result N" when absent.
     *  `chartHint` is an optional companion chart to render above the
     *  table when `renderHint === 'table'`. Read from the intent map's
     *  per-saved-search `chartHint` field. */
    toolResult?: {
        toolUseId: string;
        result: Hidden<MCPToolResult>;
        renderHint?: 'table' | 'timechart' | 'kpi' | 'pie';
        chartHint?: 'timechart' | 'kpi' | 'pie';
        /** Optional palette name. ToolResultPanel uses this for chart
         *  series colors; falls back to its auto-detect heuristic when
         *  absent. Build 139. */
        chartPalette?: ChartPalette;
        displayName?: string;
        /** Optional related-dashboard slug(s) for the "Open dashboard ↗"
         *  link in the right-pane tile's title-row actions slot. Sourced
         *  from the intent map's per-prompt `dashboard` field, plumbed
         *  through both the canned-prompt path and the AI-driven
         *  splunk_run_saved_search dispatch. Build 156 / session 027. */
        dashboard?: string | string[];
        /** Optional SPL string for the "↗ Run SPL" drill-down chip.
         *  Sourced from the canned-prompt SPL string OR the AI's ad-hoc
         *  `splunk_run_query` query OR `SAVED_SEARCH_SPL[name]` for
         *  AI-driven `splunk_run_saved_search` calls. Omitted on
         *  synthetic blocked-SPL results so the chip doesn't help the
         *  user manually run a security-blocked query. Build 172. */
        spl?: string;
        /** Splunk earliest token used at dispatch time. Plumbed through
         *  to the drill-down URL so a -24h verify query opens the Search
         *  app at -24h, not the user's current TimeRange picker.
         *  Build 172. */
        earliest?: string;
        /** Splunk latest token used at dispatch time. See `earliest`. */
        latest?: string;
    };
    /** Static guidance for kind='guidance' — interpretation + next-step
     *  suggestions surfaced after a canned-prompt tool_result lands.
     *  `toolUseId` ties the guidance to its source result so
     *  removeToolResult can prune them as a unit. Build 140.
     *  Build 141 — nextSteps entries are EITHER plain strings (no link)
     *  OR `{text, url}` link objects already resolved to a Splunk-search
     *  URL at dispatch time. The render component is dumb — no runtime
     *  SPL resolution at the chat layer. */
    guidance?: {
        toolUseId: string;
        interpretation: string;
        nextSteps: Array<string | { text: string; url: string }>;
    };
    /** Timestamp for display + audit ordering. */
    ts: number;
}

export interface AIAssistantState {
    /** Per-tab session id; baked into every audit event. */
    sessionId: string;
    /** Displayable messages (chat). */
    messages: DisplayMessage[];
    /** Visible-only outbound messages for the next vendor call. */
    vendorMessages: Message[];
    /** Streaming status. */
    status: 'idle' | 'streaming' | 'tool_executing' | 'error';
    /** Last error, if any. */
    error: Error | null;
    /** Audit events recorded this session — for the AuditModal. Mirror
     *  of what the AuditWriter forwarded to the index; does NOT flush
     *  (so the modal can show the full session history regardless of
     *  AuditWriter's batch state). */
    auditEvents: AuditEvent[];
}

export interface AIAssistantActions {
    appendMessage: (m: DisplayMessage) => void;
    setVendorMessages: (msgs: Message[]) => void;
    setStatus: (s: AIAssistantState['status']) => void;
    setError: (e: Error | null) => void;
    clearConversation: () => void;
    /** Remove the tool_call AND tool_result messages for a given
     *  `toolUseId`, plus the user message that immediately preceded the
     *  tool_call (so a canned-prompt's chat label disappears alongside
     *  its result panel). Also strips any `tool_use` / `tool_result`
     *  blocks for the same id from the outbound `vendorMessages` so the
     *  next AI turn doesn't see a dangling tool reference. */
    removeToolResult: (toolUseId: string) => void;
    /** Append an audit event to BOTH the AuditWriter (for indexing) and
     *  the in-memory list (for the AuditModal). */
    recordAudit: (event: AuditEvent) => void;
}

export interface AIAssistantContextValue {
    state: AIAssistantState;
    actions: AIAssistantActions;
    /** The active AI provider — Phase C uses MockProvider. */
    provider: AIProvider;
    /** The MCP client used for canned-prompt direct execution. */
    mcpClient: MCPClient;
    /** Audit writer for this session. */
    audit: AuditWriter;
    /** Per-tab sequence counter for ordering audit events. */
    nextAuditSeq: () => number;
    /** Splunk username for audit attribution; empty string if unknown. */
    user: string;
    /** Currently selected model id (one of `effectiveModels[].id`). */
    selectedModel: string;
    /** Update the selected model; persists to sessionStorage. */
    setSelectedModel: (id: string) => void;
    /** The model list consumers should render: the provider's static
     *  curated baseline merged with the vendor-DISCOVERED list cached
     *  in KV Store (`logserv_ai_models`). Initializes synchronously to
     *  `provider.models` and never goes empty — discovery only ever
     *  appends. Session 079 / build 275. */
    effectiveModels: ReadonlyArray<ModelDescriptor>;
    /** Lazy TTL discovery trigger — called by the chat panel on mount.
     *  Fire-and-forget: refreshes the vendor model list in the
     *  background when discovery is enabled, the provider supports it,
     *  and the cached list is absent/stale (>24h). Never throws, never
     *  blocks chat. */
    maybeRefreshModels: () => void;
    /** Power Mode toggle state (build 166 / session 028). When true,
     *  the system primer adds a rule forcing the AI to call
     *  `splunk_run_saved_search` at least once before generating any
     *  narrative response. Visible in the chat UI only when the user's
     *  Splunk role appears in the admin's `power_user_roles` config. */
    powerMode: boolean;
    /** Toggle Power Mode; persists to sessionStorage per-tab. */
    setPowerMode: (on: boolean) => void;
}

const AIAssistantContext = createContext<AIAssistantContextValue | undefined>(undefined);

interface ProviderProps {
    children: ReactNode;
    /** Override for tests / future provider-injection. */
    providerOverride?: AIProvider;
    /** Provider name to instantiate when no override given. Defaults to 'mock'. */
    providerName?: ProviderName;
    /** Admin-chosen default model for the active provider — used as the
     *  fallback when nothing is in sessionStorage and as the snap-back
     *  target when the provider changes. Per-user picks in sessionStorage
     *  still win when valid for the current provider. */
    defaultModel?: string;
    /** Override for tests. */
    mcpClientOverride?: MCPClient;
    /** Override for tests. */
    auditOverride?: AuditWriter;
    /** Splunk user; pass through from app config. */
    user?: string;
    /** Governance knob for dynamic model discovery (admin Settings →
     *  General). When false: no vendor model-list fetch ever fires AND
     *  the KV-cached discovered list is ignored, so the picker
     *  immediately reverts to the shipped static baseline. Default
     *  true (Q1 resolution). Session 079 / build 275. */
    modelDiscoveryEnabled?: boolean;
}

export const AIAssistantProvider: React.FC<ProviderProps> = ({
    children,
    providerOverride,
    providerName = 'mock',
    defaultModel,
    mcpClientOverride,
    auditOverride,
    user = '',
    modelDiscoveryEnabled = true,
}) => {
    // Generate a per-tab session id once and keep it stable.
    const sessionIdRef = useRef<string>(`s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [vendorMessages, setVendorMessagesInternal] = useState<Message[]>([]);
    const [status, setStatus] = useState<AIAssistantState['status']>('idle');
    const [error, setError] = useState<Error | null>(null);
    const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

    const seqRef = useRef<number>(0);
    const provider = useMemo(
        () => providerOverride ?? createProviderByName(providerName),
        [providerOverride, providerName],
    );
    const mcpClient = useMemo(() => mcpClientOverride ?? new MCPClient(), [mcpClientOverride]);

    // ── Dynamic model discovery (session 079 / build 275) ────────────
    //
    // `effectiveModels` = static curated baseline (provider.models) ∪
    // vendor-DISCOVERED list cached in KV Store. Initializes
    // synchronously to the baseline so no consumer ever sees an empty
    // or async-undefined list; hydrates from the KV row on mount /
    // provider change. `modelsHydrated` gates the selected-model
    // invalidation below (session-042 sticky: async hydration that
    // races a synchronous validity check needs an explicit gate —
    // otherwise a stored per-user pick of a DISCOVERED model would be
    // reset to the baseline fallback before the merged list arrives).
    const [effectiveModels, setEffectiveModels] = useState<ReadonlyArray<ModelDescriptor>>(
        provider.models,
    );
    const [modelsHydrated, setModelsHydrated] = useState<boolean>(false);

    // Selected model — sessionStorage-persisted, validated against the
    // effective (baseline ∪ discovered) model list. Resolution order:
    //   1. sessionStorage (per-user pick from the chat panel, valid only
    //      if it's still in this provider's effective list)
    //   2. defaultModel prop (admin's default from the Settings page),
    //      again only if valid for this provider
    //   3. effectiveModels[0].id (baseline-first merge order means this
    //      is always the provider's first curated model)
    //
    // The useState initializer runs against the synchronous baseline;
    // a stored pick that's only in the DISCOVERED set is re-applied by
    // the hydration effect once the merged list is known.
    //
    // The admin's defaultModel may not match every provider — if an
    // admin switches the active provider in Settings, the saved
    // default_model is whatever they picked in the General panel's
    // model dropdown for THAT provider. So when the React app receives
    // a defaultModel prop, it's already provider-appropriate.
    const resolveInitialModel = (): string => {
        try {
            const stored = window.sessionStorage.getItem(SESSION_KEY_SELECTED_MODEL);
            if (stored && provider.models.some((m) => m.id === stored)) return stored;
        } catch (_e) { /* ignore */ }
        if (defaultModel && provider.models.some((m) => m.id === defaultModel)) {
            return defaultModel;
        }
        return provider.models[0]?.id ?? '';
    };
    const [selectedModel, setSelectedModelState] = useState<string>(resolveInitialModel);

    // Hydrate the discovered-model cache on mount + provider change.
    // With discovery disabled, serve the static baseline and mark
    // hydration resolved immediately (nothing async to wait for).
    useEffect(() => {
        let cancelled = false;
        setEffectiveModels(provider.models);
        setModelsHydrated(false);
        if (!modelDiscoveryEnabled) {
            setModelsHydrated(true);
            return undefined;
        }
        (async () => {
            const row = await readModelCacheRow(provider.name);
            if (cancelled) return;
            const discovered = row && row.models ? row.models : [];
            const merged = mergeModels(provider.models, discovered);
            setEffectiveModels(merged);
            setModelsHydrated(true);
            // Re-apply a stored per-user pick that only became valid
            // with the merged list (verification-protocol #3: a
            // sessionStorage selection of a DISCOVERED model survives
            // reload).
            try {
                const stored = window.sessionStorage.getItem(SESSION_KEY_SELECTED_MODEL);
                if (stored && merged.some((m) => m.id === stored)) {
                    setSelectedModelState(stored);
                }
            } catch (_e) { /* ignore */ }
        })();
        return () => {
            cancelled = true;
        };
    }, [provider, modelDiscoveryEnabled]);

    // Re-validate when the provider or the effective list changes —
    // GATED on hydration so the async KV read can't race the check.
    useEffect(() => {
        if (!modelsHydrated) return;
        const isValid = effectiveModels.some((m) => m.id === selectedModel);
        if (!isValid) {
            const fallback =
                (defaultModel && effectiveModels.some((m) => m.id === defaultModel)
                    ? defaultModel
                    : effectiveModels[0]?.id) ?? '';
            setSelectedModelState(fallback);
            try {
                window.sessionStorage.setItem(SESSION_KEY_SELECTED_MODEL, fallback);
            } catch (_e) { /* ignore */ }
        }
    }, [modelsHydrated, effectiveModels, selectedModel, defaultModel]);
    const setSelectedModel = useCallback((id: string): void => {
        setSelectedModelState(id);
        try {
            window.sessionStorage.setItem(SESSION_KEY_SELECTED_MODEL, id);
        } catch (_e) { /* ignore */ }
    }, []);

    // Lazy TTL discovery — invoked by the chat panel on mount (NOT by
    // this provider itself: AIAssistantProvider mounts unconditionally
    // at the app root, and a user who never opens the AI panel should
    // trigger zero vendor calls). modelDiscovery.ts enforces the
    // skip-mock / once-per-page-load / 24h-TTL rules.
    const maybeRefreshModels = useCallback((): void => {
        if (!modelDiscoveryEnabled) return;
        void (async () => {
            try {
                const fresh = await maybeRefreshModelsTtl(provider, user);
                if (fresh) {
                    setEffectiveModels(mergeModels(provider.models, fresh));
                }
            } catch (_e) {
                // background refresh is best-effort; static floor stands
            }
        })();
    }, [provider, user, modelDiscoveryEnabled]);

    /* Power Mode (build 166 / session 028) — per-tab sessionStorage so
     * the user's last choice survives reloads but doesn't leak across
     * tabs. Defaults to OFF on first mount. */
    const resolveInitialPowerMode = (): boolean => {
        try {
            return window.sessionStorage.getItem(SESSION_KEY_POWER_MODE) === '1';
        } catch (_e) {
            return false;
        }
    };
    const [powerMode, setPowerModeState] = useState<boolean>(resolveInitialPowerMode);
    const setPowerMode = useCallback((on: boolean): void => {
        setPowerModeState(on);
        try {
            window.sessionStorage.setItem(SESSION_KEY_POWER_MODE, on ? '1' : '0');
        } catch (_e) { /* ignore */ }
    }, []);

    const audit = useMemo(() => auditOverride ?? new AuditWriter(), [auditOverride]);

    const appendMessage = (m: DisplayMessage): void => {
        setMessages((prev) => [...prev, m]);
    };

    const setVendorMessages = (msgs: Message[]): void => {
        setVendorMessagesInternal(msgs);
    };

    const clearConversation = (): void => {
        setMessages([]);
        setVendorMessagesInternal([]);
        setStatus('idle');
        setError(null);
        setAuditEvents([]);
    };

    const removeToolResult = (toolUseId: string): void => {
        setMessages((prev) => {
            // Find the tool_call's index so we can also drop the user
            // message that immediately precedes it (canned-prompt label).
            const toolCallIdx = prev.findIndex(
                (m) => m.kind === 'tool_call' && m.toolCall?.toolUseId === toolUseId,
            );
            const userIdx =
                toolCallIdx > 0 && prev[toolCallIdx - 1].kind === 'user'
                    ? toolCallIdx - 1
                    : -1;
            return prev.filter((m, idx) => {
                if (idx === userIdx) return false;
                if (m.kind === 'tool_call' && m.toolCall?.toolUseId === toolUseId) return false;
                if (m.kind === 'tool_result' && m.toolResult?.toolUseId === toolUseId) return false;
                // Build 140: also prune the guidance message tied to this
                // toolUseId so the chat doesn't leave an orphaned "How to
                // read this result" block pointing at nothing.
                if (m.kind === 'guidance' && m.guidance?.toolUseId === toolUseId) return false;
                return true;
            });
        });
        // Strip outbound vendor message references so the next AI turn
        // doesn't see a tool_use without a matching tool_result.
        setVendorMessagesInternal((prev) =>
            prev
                .map((msg) => ({
                    ...msg,
                    toolCalls: msg.toolCalls?.filter(
                        (tc) => String(tc.toolUseId) !== toolUseId,
                    ),
                    toolResults: msg.toolResults?.filter(
                        (tr) => String(tr.toolUseId) !== toolUseId,
                    ),
                }))
                // If a message is now empty (no content + no tool refs), drop it.
                .filter(
                    (msg) =>
                        String(msg.content).length > 0 ||
                        (msg.toolCalls && msg.toolCalls.length > 0) ||
                        (msg.toolResults && msg.toolResults.length > 0),
                ),
        );
    };

    const recordAudit = (event: AuditEvent): void => {
        audit.record(event);
        setAuditEvents((prev) => [...prev, event]);
    };

    const nextAuditSeq = (): number => {
        seqRef.current += 1;
        return seqRef.current;
    };

    const value = useMemo<AIAssistantContextValue>(
        () => ({
            state: {
                sessionId: sessionIdRef.current,
                messages,
                vendorMessages,
                status,
                error,
                auditEvents,
            },
            actions: {
                appendMessage,
                setVendorMessages,
                setStatus,
                setError,
                clearConversation,
                removeToolResult,
                recordAudit,
            },
            provider,
            mcpClient,
            audit,
            nextAuditSeq,
            user,
            selectedModel,
            setSelectedModel,
            effectiveModels,
            maybeRefreshModels,
            powerMode,
            setPowerMode,
        }),
        [messages, vendorMessages, status, error, auditEvents, provider, mcpClient, audit, user, selectedModel, setSelectedModel, effectiveModels, maybeRefreshModels, powerMode, setPowerMode],
    );

    return <AIAssistantContext.Provider value={value}>{children}</AIAssistantContext.Provider>;
};

export const useAIAssistantContext = (): AIAssistantContextValue => {
    const ctx = useContext(AIAssistantContext);
    if (!ctx) {
        throw new Error('useAIAssistantContext must be used inside AIAssistantProvider');
    }
    return ctx;
};
