import React, { useCallback, useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import TabLayout from '@splunk/react-ui/TabLayout';
import Multiselect from '@splunk/react-ui/Multiselect';
import { listSplunkRoles } from '../utils/splunkRolesApi';
import { parsePowerUserRoles } from '../state/AIAssistantConfig';
import DashboardLayout from '../components/DashboardLayout';
import FramedPanel from '../components/FramedPanel';
import AuditLogViewer from '../components/AuditLogViewer';
import TopologySettingsPanel from '../components/TopologySettingsPanel';
import { useIsAdmin } from '../hooks/useIsAdmin';
import {
    CredentialSummary,
    deleteCredential,
    readCredentialClear,
    readCredentialSummary,
    writeCredential,
} from '../utils/passwordsApi';
import {
    AIConfigSettings,
    DEFAULT_AI_CONFIG,
    PrivacyTier,
    ProviderName,
    readAIConfig,
    writeAIConfig,
} from '../utils/aiConfigApi';
import { createProviderByName } from '../components/ai/providers';
import {
    AiAssistantEnableAcceptanceEvent,
    AuditWriter,
    ForwarderDisabledAcceptanceEvent,
    VendorTier2ElevationEvent,
    setAuditForwarderConfig,
} from '../components/ai/audit';
import { logservTheme } from '../styles/logservTheme';
import ForwarderDisabledAcceptanceModal from '../components/ForwarderDisabledAcceptanceModal';
import AiAssistantEnableAcceptanceModal from '../components/AiAssistantEnableAcceptanceModal';
import {
    OptInChoice,
    STANZA_ENABLE_TC,
    STANZA_FORWARDER_TC,
    TcAcknowledgementState,
    readTcAcknowledgement,
    writeTcAcknowledgement,
} from '../utils/telemetryConfApi';

/**
 * AIAssistantSettings — admin-only configuration page for the AI
 * Assistant feature.
 *
 * Sections:
 *   • LLM Providers — Anthropic, OpenAI, Azure OpenAI, AWS Bedrock,
 *     Ollama. Each provider's keys are stored in `passwords.conf` under
 *     the `logserv_ai_assistant_<provider>` realm with one entry per
 *     field (api_key, endpoint, region, etc.).
 *   • MCP Server — server URL + bearer token (admin pastes a
 *     pre-obtained token; auto-mint comes in Phase G).
 *
 * Auth:
 *   The page is admin-gated via `useIsAdmin`. Non-admins see a 403-style
 *   fallback. Splunk also enforces this on the server side: writing to
 *   `storage/passwords` requires `edit_storage_passwords` and reading
 *   `clear_password` requires `list_storage_passwords` — both belong to
 *   the admin role.
 *
 * UX guarantees:
 *   • Existing credentials are NEVER displayed in cleartext. The page
 *     fetches a summary (length + 7-char prefix) and shows that.
 *   • Empty input fields mean "no change". Saving a non-empty value
 *     replaces the stored credential.
 *   • A "Clear" button next to each field deletes the stored credential.
 */

// ─── styled primitives ────────────────────────────────────────────────────
const SectionGrid = styled.div`
    display: grid;
    grid-template-columns: 1fr;
    gap: ${logservTheme.elevation.panelGap};
`;

const FieldRow = styled.div`
    display: grid;
    grid-template-columns: 200px 1fr auto;
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: ${logservTheme.spacing.sm} 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};

    &:last-child { border-bottom: 0; }
`;

/**
 * Section heading for grouping General-tab FieldRows under semantic
 * subsections (Feature / Limits & Quotas / Privacy / Audit & Telemetry).
 * Build 135 / session 024 path C — the General tab grew to 14 fields
 * over sessions 016 → 022; visual grouping makes it scannable.
 *
 * Margin-top inset on every instance except the first so the first heading
 * doesn't push the panel below the FramedPanel padding.
 */
const SectionHeading = styled.h3`
    margin: ${logservTheme.spacing.lg} 0 0;
    padding: ${logservTheme.spacing.xs} 0 ${logservTheme.spacing.sm};
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.cyanLight};
    text-transform: uppercase;
    letter-spacing: 1.2px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};

    /* First heading sits flush with the panel top — the FramedPanel already
     * provides the breathing room, no need for extra margin-top. */
    &:first-child {
        margin-top: 0;
    }
`;

const FieldLabel = styled.label`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const FieldHint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-top: 2px;
`;

const FieldStatus = styled.div<{ $tone: 'good' | 'absent' | 'error' }>`
    color: ${(p) =>
        p.$tone === 'good'
            ? logservTheme.colors.teal
            : p.$tone === 'error'
            ? logservTheme.colors.red
            : logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    font-style: italic;
`;

const FieldInput = styled.input`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    min-width: 280px;

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const FieldSelect = styled.select`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    min-width: 280px;

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const ToggleLabel = styled.label`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    cursor: pointer;
`;

const RadioRow = styled.div`
    display: inline-flex;
    gap: ${logservTheme.spacing.lg};
    flex-wrap: wrap;
`;

const RadioOption = styled.label`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.xs};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    cursor: pointer;
`;

const GeneralActionsRow = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: ${logservTheme.spacing.sm};
    padding-top: ${logservTheme.spacing.md};
`;

const ButtonRow = styled.div`
    display: inline-flex;
    gap: ${logservTheme.spacing.sm};
`;

const Button = styled.button<{ $variant?: 'primary' | 'danger' }>`
    background: ${(p) =>
        p.$variant === 'primary'
            ? logservTheme.colors.cyanAccent
            : p.$variant === 'danger'
            ? logservTheme.colors.red
            : 'transparent'};
    color: ${(p) =>
        p.$variant === 'primary' || p.$variant === 'danger'
            ? '#ffffff'
            : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$variant === 'primary'
                ? logservTheme.colors.cyanAccent
                : p.$variant === 'danger'
                ? logservTheme.colors.red
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};

    &:hover:not(:disabled) {
        opacity: 0.85;
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const ForbiddenBlock = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.red};
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textActive};
    padding: ${logservTheme.spacing.xl};
    margin-top: ${logservTheme.spacing.lg};
`;

const StatusBanner = styled.div<{ $tone: 'success' | 'error' | 'info' }>`
    background: ${(p) =>
        p.$tone === 'success'
            ? 'rgba(0, 212, 180, 0.12)'
            : p.$tone === 'error'
            ? 'rgba(220, 78, 65, 0.12)'
            : 'rgba(8, 119, 166, 0.12)'};
    border: 1px solid
        ${(p) =>
            p.$tone === 'success'
                ? logservTheme.colors.teal
                : p.$tone === 'error'
                ? logservTheme.colors.red
                : logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.textActive};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    border-radius: ${logservTheme.radius.small};
    font-size: ${logservTheme.fontSize.body};
    margin-bottom: ${logservTheme.spacing.md};
`;

// ─── form schema ──────────────────────────────────────────────────────────
interface FieldDef {
    realm: string;
    name: string;
    label: string;
    hint: string;
    /** Optional prefix the input must start with (validates before save). */
    expectedPrefix?: string;
    /** Optional minimum length (validates before save). */
    minLength?: number;
    /** Whether to show a 7-char prefix in the "stored" summary. */
    showPrefix?: boolean;
}

const REALM = (provider: string): string => `logserv_ai_assistant_${provider}`;

const PROVIDER_FIELDS: { sectionTitle: string; subtitle: string; fields: FieldDef[] }[] = [
    {
        sectionTitle: 'Anthropic',
        subtitle: 'Claude models. Get keys at console.anthropic.com → Settings → API Keys.',
        fields: [
            {
                realm: REALM('anthropic'),
                name: 'api_key',
                label: 'API Key',
                hint: 'Starts with sk-ant- (~108 chars).',
                expectedPrefix: 'sk-ant-',
                minLength: 40,
                showPrefix: true,
            },
        ],
    },
    {
        sectionTitle: 'OpenAI',
        subtitle: 'GPT models via api.openai.com. Get keys at platform.openai.com/api-keys.',
        fields: [
            {
                realm: REALM('openai'),
                name: 'api_key',
                label: 'API Key',
                hint: 'Starts with sk- or sk-proj- (~50+ chars).',
                expectedPrefix: 'sk-',
                minLength: 30,
                showPrefix: true,
            },
        ],
    },
    {
        sectionTitle: 'Azure OpenAI',
        subtitle: 'Self-hosted OpenAI on Azure. Find in Azure portal → your OpenAI resource → Keys and Endpoint.',
        fields: [
            {
                realm: REALM('azure_openai'),
                name: 'api_key',
                label: 'API Key',
                hint: '32-char hex string.',
                minLength: 32,
                showPrefix: false,
            },
            {
                realm: REALM('azure_openai'),
                name: 'endpoint',
                label: 'Endpoint URL',
                hint: 'Full HTTPS URL of your Azure OpenAI resource (e.g. https://my-resource.openai.azure.com).',
                minLength: 10,
                showPrefix: true,
            },
            {
                realm: REALM('azure_openai'),
                name: 'deployment',
                label: 'Deployment Name',
                hint: 'The deployment name configured in your Azure OpenAI resource.',
                minLength: 1,
                showPrefix: true,
            },
        ],
    },
    {
        sectionTitle: 'AWS Bedrock',
        subtitle: 'Claude models on AWS Bedrock via Bedrock API keys (NOT IAM SigV4 — see Phase G for that).',
        fields: [
            {
                realm: REALM('bedrock'),
                name: 'api_key',
                label: 'API Key',
                hint: 'AWS Bedrock API key (Bedrock console → API keys).',
                minLength: 20,
                showPrefix: true,
            },
            {
                realm: REALM('bedrock'),
                name: 'region',
                label: 'AWS Region',
                hint: 'AWS region for Bedrock (e.g. us-east-1, ap-south-1).',
                minLength: 4,
                showPrefix: true,
            },
        ],
    },
    {
        sectionTitle: 'Ollama (Tier 0 — air-gapped local)',
        subtitle: 'OpenAI-compatible local LLM. No key required; only the URL.',
        fields: [
            {
                realm: REALM('ollama'),
                name: 'url',
                label: 'Base URL',
                hint: 'Ollama server URL, e.g. http://localhost:11434.',
                expectedPrefix: 'http',
                minLength: 7,
                showPrefix: true,
            },
        ],
    },
];

const MCP_FIELDS: FieldDef[] = [
    {
        realm: 'logserv_ai_assistant_mcp',
        name: 'bearer_token',
        label: 'Bearer Token',
        hint: 'OAuth/JWT token issued by your Splunk MCP Server. The admin pastes this; Phase G mints it automatically.',
        minLength: 20,
        showPrefix: true,
    },
];

const AUDIT_FORWARDER_FIELDS: FieldDef[] = [
    {
        realm: 'logserv_ai_assistant_forwarder',
        name: 'hec_token',
        label: 'HEC Token',
        hint: 'HTTP Event Collector token issued by the destination Splunk / SIEM. Used to authenticate audit-event POSTs from this Splunk Web tab to the forwarder URL configured under General. Must be a token with `ai_assistant_audit` (or your remote-index-of-choice) write permission. The destination must also allow CORS from this Splunk Web origin.',
        minLength: 20,
        showPrefix: true,
    },
];

// ─── General defaults panel ───────────────────────────────────────────────
const PROVIDER_OPTIONS: ReadonlyArray<{ id: ProviderName; label: string }> = [
    { id: 'mock', label: 'Mock (development only)' },
    { id: 'anthropic', label: 'Anthropic (Claude)' },
    { id: 'openai', label: 'OpenAI (GPT)' },
    { id: 'azure_openai', label: 'Azure OpenAI' },
    { id: 'bedrock', label: 'AWS Bedrock (Claude)' },
    { id: 'ollama', label: 'Ollama (Tier 0 — local)' },
];

/**
 * Resolve the model list for a provider by instantiating it. Provider
 * constructors are cheap (no I/O — credentials are read on stream(),
 * not on construction).
 */
const getModelOptions = (
    providerName: ProviderName,
): ReadonlyArray<{ id: string; label: string }> => {
    try {
        const p = createProviderByName(providerName);
        return p.models.map((m) => ({ id: m.id, label: m.label }));
    } catch {
        return [];
    }
};

const TIER_DESCRIPTIONS: Record<PrivacyTier, string> = {
    0: 'Tier 0 — air-gapped local (no outbound vendor calls)',
    1: 'Tier 1 — cloud LLM, queries only (default)',
    2: 'Tier 2 — cloud LLM, aggregated metadata (admin opt-in)',
};

interface GeneralPanelProps {
    onSaved: () => void;
    /** Splunk username of the admin saving the change. Used to attribute
     *  the `vendor_tier2_elevation` audit event when a save crosses the
     *  not-2 → 2 boundary. */
    adminUsername: string;
    /** Bubbled up from AppShell → App.tsx. Called after a successful
     *  `writeAIConfig` so the App-level cached `AIAssistantConfig` is
     *  re-read and downstream UI (the AI Assistant button + side panel
     *  + privacy banner) reacts immediately to the saved change.
     *  Build 101 / session 022. */
    onConfigSaved?: () => Promise<void> | void;
}

const GeneralPanel: React.FC<GeneralPanelProps> = ({ onSaved, adminUsername, onConfigSaved }) => {
    const [loaded, setLoaded] = useState<boolean>(false);
    const [draft, setDraft] = useState<AIConfigSettings>(DEFAULT_AI_CONFIG);
    const [saved, setSaved] = useState<AIConfigSettings>(DEFAULT_AI_CONFIG);
    const [busy, setBusy] = useState<boolean>(false);
    const [opError, setOpError] = useState<string | null>(null);
    // Two acceptance modals, gated independently by the matching
    // telemetry.conf stanza version state. Both follow Splunk's
    // optInVersion pattern: any interaction (yes OR no) bumps the
    // conf, the choice is recorded, the modal does not re-show until
    // the operator bumps `optInVersion` in default/ai_assistant_acks.conf.
    //
    //   * forwarderTcState — gates the audit-log integrity prompt
    //     when audit_forwarder_enabled is being left off (build 99).
    //   * enableTcState — gates the AI Assistant feature-enablement
    //     liability prompt when `enabled` is true (build 100).
    //
    // On a fresh install, both modals may apply; they are shown
    // sequentially: enable first (more critical — turning on the
    // feature), forwarder second (audit-log integrity). A "no" on
    // the enable modal aborts the entire save chain.
    const [forwarderModalOpen, setForwarderModalOpen] = useState<boolean>(false);
    const [enableModalOpen, setEnableModalOpen] = useState<boolean>(false);
    const initialTcState: TcAcknowledgementState = {
        optInVersion: 1,
        optInVersionAcknowledged: 0,
        optInChoice: '',
        optInChoiceAt: '',
    };
    const [forwarderTcState, setForwarderTcState] = useState<TcAcknowledgementState>(initialTcState);
    const [enableTcState, setEnableTcState] = useState<TcAcknowledgementState>(initialTcState);

    /* Splunk role catalog for the Power Mode allow-list multiselect.
     * Loaded once on mount via `services/authentication/roles`. Empty
     * array on REST failure (which falls back to a free-text input
     * disabled state — admin still sees their currently-saved CSV in
     * the placeholder so they can edit it manually if needed). */
    const [availableRoles, setAvailableRoles] = useState<string[]>([]);
    const [rolesLoaded, setRolesLoaded] = useState<boolean>(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [cfg, fwdTc, enTc, roles] = await Promise.all([
                    readAIConfig(),
                    readTcAcknowledgement(STANZA_FORWARDER_TC),
                    readTcAcknowledgement(STANZA_ENABLE_TC),
                    listSplunkRoles(),
                ]);
                if (cancelled) return;
                setDraft(cfg);
                setSaved(cfg);
                setForwarderTcState(fwdTc);
                setEnableTcState(enTc);
                setAvailableRoles(roles);
                setRolesLoaded(true);
            } finally {
                if (!cancelled) setLoaded(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const modelOptions = useMemo(
        () => getModelOptions(draft.provider),
        [draft.provider],
    );

    // If the saved default_model isn't in the new provider's list, snap
    // to that provider's first model so the dropdown doesn't show an
    // out-of-list value.
    useEffect(() => {
        if (modelOptions.length === 0) return;
        if (!modelOptions.some((m) => m.id === draft.default_model)) {
            setDraft((d) => ({ ...d, default_model: modelOptions[0].id }));
        }
    }, [modelOptions, draft.default_model]);

    const dirty = useMemo(
        () =>
            (Object.keys(draft) as Array<keyof AIConfigSettings>).some(
                (k) => draft[k] !== saved[k],
            ),
        [draft, saved],
    );

    /**
     * Persist the draft to ai_assistant_settings.conf, fire whichever
     * audit events the transition warrants, and reapply forwarder
     * config to the running AuditWriter so subsequent events take the
     * new posture without a page reload.
     *
     * Build 98 introduced this for the audit-integrity modal flow.
     * Build 99 extended it: the acceptance now records via Splunk's
     * standard `configs/conf-ai_assistant_acks` endpoint AND in the audit
     * log, with both yes and no choices captured per Splunk's
     * `optInVersion` pattern.
     */
    const actuallySave = async (
        acceptance?: { choice: OptInChoice; disclaimerHash: string; tcVersion: number },
    ): Promise<void> => {
        setBusy(true);
        setOpError(null);
        try {
            // Capture pre-save state so audit events reflect the actual
            // transition the admin just performed, not post-save state.
            const previousTier = saved.tier;
            const previousForwarderEnabled = saved.audit_forwarder_enabled;
            await writeAIConfig(draft);
            setSaved(draft);
            onSaved();
            // Bubble the save up to App.tsx so its cached
            // AIAssistantConfig is refreshed and the AI Assistant
            // button + side panel + privacy banner react immediately
            // to the new state — without this, toggling `enabled`
            // off in Settings leaves the button visible until the
            // tab is hard-refreshed. Build 101 / session 022.
            if (onConfigSaved) {
                try {
                    await onConfigSaved();
                } catch (_e) {
                    // Refresh-side failure is non-fatal — the conf
                    // is already saved; worst case the admin has
                    // to refresh manually.
                }
            }

            // Apply the new forwarder config to the running AuditWriter
            // so existing chat sessions and any subsequent settings-page
            // one-off events use the new posture immediately. The HEC
            // token is read separately because it lives in
            // passwords.conf, not ai_assistant_settings.conf — we read
            // it on every save in case the admin changed it under
            // Splunk MCP → Audit Forwarder. An empty token + enabled=
            // true silently skips forwarding (with audit_forwarder_failure
            // events surfacing the misconfig to SOC).
            try {
                const hecToken = await readCredentialClear(
                    'logserv_ai_assistant_forwarder',
                    'hec_token',
                );
                setAuditForwarderConfig({
                    enabled: draft.audit_forwarder_enabled,
                    url: draft.audit_forwarder_url,
                    hecToken,
                    index: draft.audit_forwarder_index,
                    source: draft.audit_forwarder_source,
                });
            } catch (_e) {
                // Don't fail the save UX if the token read fails;
                // the writer just won't forward until next page load.
            }

            // OWASP LLM02 — Tier 2 elevation event.
            if (draft.tier === 2 && previousTier !== 2) {
                const elevation: VendorTier2ElevationEvent = {
                    timestamp: new Date().toISOString(),
                    user: adminUsername || 'unknown',
                    sessionId: `settings-${Date.now().toString(36)}`,
                    seq: 1,
                    category: 'vendor_tier2_elevation',
                    previousTier: previousTier as 0 | 1,
                    newTier: 2,
                    provider: draft.provider,
                };
                void AuditWriter.postOneOff(elevation);
            }

            // Audit-integrity acknowledgement event — fired when the
            // admin INTERACTED with the modal (yes OR no). Build 99:
            // both choices are recorded; the version is bumped on
            // either via the standard Splunk telemetry endpoint.
            if (acceptance) {
                const acceptanceEvent: ForwarderDisabledAcceptanceEvent = {
                    timestamp: new Date().toISOString(),
                    user: adminUsername || 'unknown',
                    sessionId: `settings-${Date.now().toString(36)}`,
                    seq: 1,
                    category: 'forwarder_disabled_acceptance',
                    acceptedAt: new Date().toISOString(),
                    disclaimerHash: acceptance.disclaimerHash,
                    provider: draft.provider,
                    previousEnabledState: previousForwarderEnabled,
                    tcVersion: acceptance.tcVersion,
                    optInChoice: acceptance.choice,
                };
                void AuditWriter.postOneOff(acceptanceEvent);
            }

            setForwarderModalOpen(false);
            setEnableModalOpen(false);
        } catch (e) {
            setOpError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Save handler bound to the General-panel "Save Defaults" button.
     *
     * Modal gating chain (Build 99 + Build 100 — Splunk optInVersion
     * pattern, two stanzas):
     *
     *   1. If the resulting state has `enabled = true` AND the AI
     *      Assistant feature-enablement liability T&C
     *      (logserv-ai-assistant-enable-tc) has not been acknowledged
     *      at the current optInVersion → open the enable modal first.
     *      Highest-stakes acknowledgement (turning on the feature).
     *
     *   2. Otherwise, if the resulting state has
     *      `audit_forwarder_enabled = false` AND the audit-log
     *      integrity T&C (logserv-ai-assistant-tc) has not been
     *      acknowledged at the current optInVersion → open the
     *      forwarder modal.
     *
     *   3. Otherwise → save immediately.
     *
     * After the enable modal completes with "yes", the chain
     * re-evaluates and may open the forwarder modal next. A "no"
     * on either modal aborts the save and the chain.
     */
    /**
     * Whether the AI Assistant feature-enablement liability modal
     * should open on this save.
     *
     * Triggers when the resulting state has `enabled = true` AND
     * either:
     *
     *   (a) the admin is transitioning from enabled=false → true
     *       (every "I'm turning this on" deliberate action shows the
     *        legal disclaimer, regardless of prior ack history); OR
     *   (b) the conf's optInVersionAcknowledged is behind the current
     *       optInVersion (operator bumped the version after a
     *       wording change).
     *
     * Original build-100 logic was (b) only — the strict Splunk
     * optInVersion pattern. Build 102 added (a) because legal-liability
     * acknowledgement should fire on every deliberate enable, not just
     * once per wording revision: an admin who disables then re-enables
     * a week later may be a different person, may have new context,
     * or may simply benefit from re-reading the terms before re-
     * accepting indemnification obligations.
     *
     * The forwarder modal applies the same transition rule (build
     * 102 update): every time the admin transitions
     * audit_forwarder_enabled from true → false (deliberately turning
     * off off-host tamper-evidence), the audit-log integrity modal
     * fires regardless of prior ack history. Same rationale — a
     * deliberate disable is a security-posture change that warrants
     * re-acknowledgement on each occurrence.
     */
    const isEnableTcPending = (): boolean => {
        if (!draft.enabled) return false;
        if (!saved.enabled) return true; // transition false → true
        return enableTcState.optInVersionAcknowledged < enableTcState.optInVersion;
    };

    const isForwarderTcPending = (): boolean => {
        if (draft.audit_forwarder_enabled) return false;
        if (saved.audit_forwarder_enabled) return true; // transition true → false
        return forwarderTcState.optInVersionAcknowledged < forwarderTcState.optInVersion;
    };

    const handleSave = async (): Promise<void> => {
        if (isEnableTcPending()) {
            setEnableModalOpen(true);
            return;
        }
        if (isForwarderTcPending()) {
            setForwarderModalOpen(true);
            return;
        }
        await actuallySave();
    };

    /**
     * Enable modal callback — admin made their yes/no choice on the
     * AI Assistant feature-enablement liability disclaimer. Per
     * Splunk's optInVersion pattern, ANY interaction bumps the
     * acknowledged version; the boolean choice is recorded in both
     * the standard Splunk telemetry conf and the audit log.
     *
     * Save behaviour:
     *   - yes  → close enable modal; if forwarder TC also pending,
     *            open it next; otherwise save immediately.
     *   - no   → save aborted, `enabled` stays at its previous saved
     *            value. The forwarder TC chain is NOT triggered (no
     *            cascading re-prompt for an aborted save).
     */
    const handleEnableChoice = async (
        choice: OptInChoice,
        disclaimerHash: string,
    ): Promise<void> => {
        const versionAtChoice = enableTcState.optInVersion;
        try {
            await writeTcAcknowledgement(STANZA_ENABLE_TC, choice, versionAtChoice);
            setEnableTcState((prev) => ({
                ...prev,
                optInVersionAcknowledged: versionAtChoice,
                optInChoice: choice,
                optInChoiceAt: new Date().toISOString(),
            }));
        } catch (e) {
            setOpError(
                `Failed to record acknowledgement via Splunk telemetry endpoint: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
            return;
        }

        // Fire the audit event for both yes and no. Per Splunk pattern,
        // both interactions are recorded.
        const acceptanceEvent: AiAssistantEnableAcceptanceEvent = {
            timestamp: new Date().toISOString(),
            user: adminUsername || 'unknown',
            sessionId: `settings-${Date.now().toString(36)}`,
            seq: 1,
            category: 'ai_assistant_enable_acceptance',
            acceptedAt: new Date().toISOString(),
            disclaimerHash,
            provider: draft.provider,
            previousEnabledState: saved.enabled,
            tcVersion: versionAtChoice,
            optInChoice: choice,
        };
        void AuditWriter.postOneOff(acceptanceEvent);

        setEnableModalOpen(false);

        if (choice === 'no') {
            setOpError(
                'Save aborted — AI Assistant liability terms declined. The "Enable AI Assistant" toggle was not changed.',
            );
            return;
        }

        // 'yes' — chain to the forwarder modal if applicable, else save.
        if (isForwarderTcPending()) {
            setForwarderModalOpen(true);
            return;
        }
        await actuallySave();
    };

    /**
     * Forwarder modal callback — same shape as handleEnableChoice
     * but for the audit-log-integrity T&C stanza.
     *
     * Save behaviour:
     *   - yes  → save proceeds with `audit_forwarder_enabled` still
     *            off (admin accepted that posture)
     *   - no   → save aborted, forwarder remains at its previous saved
     *            state, but the conf records the interaction so the
     *            modal won't re-show until `optInVersion` is bumped.
     */
    const handleForwarderChoice = async (
        choice: OptInChoice,
        disclaimerHash: string,
    ): Promise<void> => {
        const versionAtChoice = forwarderTcState.optInVersion;
        try {
            await writeTcAcknowledgement(STANZA_FORWARDER_TC, choice, versionAtChoice);
            setForwarderTcState((prev) => ({
                ...prev,
                optInVersionAcknowledged: versionAtChoice,
                optInChoice: choice,
                optInChoiceAt: new Date().toISOString(),
            }));
        } catch (e) {
            setOpError(
                `Failed to record acknowledgement via Splunk telemetry endpoint: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
            return;
        }

        if (choice === 'yes') {
            await actuallySave({
                choice,
                disclaimerHash,
                tcVersion: versionAtChoice,
            });
        } else {
            const acceptanceEvent: ForwarderDisabledAcceptanceEvent = {
                timestamp: new Date().toISOString(),
                user: adminUsername || 'unknown',
                sessionId: `settings-${Date.now().toString(36)}`,
                seq: 1,
                category: 'forwarder_disabled_acceptance',
                acceptedAt: new Date().toISOString(),
                disclaimerHash,
                provider: draft.provider,
                previousEnabledState: saved.audit_forwarder_enabled,
                tcVersion: versionAtChoice,
                optInChoice: 'no',
            };
            void AuditWriter.postOneOff(acceptanceEvent);
            setForwarderModalOpen(false);
            setOpError(
                'Save aborted — audit-forwarder acknowledgement recorded as "No". The forwarder configuration was not changed.',
            );
        }
    };

    const handleRevert = (): void => {
        setDraft(saved);
        setOpError(null);
    };

    if (!loaded) {
        return (
            <FieldStatus $tone="absent">Loading current defaults…</FieldStatus>
        );
    }

    return (
        <>
            <SectionHeading>Feature</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Enable AI Assistant</FieldLabel>
                    <FieldHint>
                        When off, the AI Assistant button is hidden for all
                        users and the MCP probe never runs.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) =>
                            setDraft((d) => ({ ...d, enabled: e.target.checked }))
                        }
                        disabled={busy}
                    />
                    {draft.enabled ? 'Enabled' : 'Disabled'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel>Templates-only mode</FieldLabel>
                    <FieldHint>
                        When on, the free-form / LLM-driven path is disabled
                        at runtime: chat input is read-only, the model picker
                        and Power Mode toggle are hidden, the Provider
                        Credentials tab is hidden, and an info banner explains
                        the mode. The predefined-prompt path + Splunk MCP
                        Server integration + audit log all stay fully active.
                        Use this for demonstration environments and
                        restricted-environment customers where LLM dispatch
                        should not be available, without rebuilding the app.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.templates_only_mode}
                        onChange={(e) =>
                            setDraft((d) => ({
                                ...d,
                                templates_only_mode: e.target.checked,
                            }))
                        }
                        disabled={busy}
                    />
                    {draft.templates_only_mode ? 'Templates-only' : 'Full LLM path'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-provider">Active Provider</FieldLabel>
                    <FieldHint>
                        The LLM vendor used by every user of this app. Per-user
                        switching is intentionally not exposed.
                    </FieldHint>
                </div>
                <FieldSelect
                    id="ai-provider"
                    value={draft.provider}
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            provider: e.target.value as ProviderName,
                        }))
                    }
                    disabled={busy}
                >
                    {PROVIDER_OPTIONS.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </FieldSelect>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-default-model">
                        Default Model
                    </FieldLabel>
                    <FieldHint>
                        First model selected when a user opens the AI Assistant.
                        Users can switch to any other model from this provider.
                    </FieldHint>
                </div>
                <FieldSelect
                    id="ai-default-model"
                    value={draft.default_model}
                    onChange={(e) =>
                        setDraft((d) => ({ ...d, default_model: e.target.value }))
                    }
                    disabled={busy || modelOptions.length === 0}
                >
                    {modelOptions.length === 0 && (
                        <option value="">(no models exposed by this provider)</option>
                    )}
                    {modelOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.label}
                        </option>
                    ))}
                </FieldSelect>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel>Privacy Tier</FieldLabel>
                    <FieldHint>
                        Controls which data the AI Assistant is allowed to send
                        to the vendor. See the design doc for the full matrix.
                    </FieldHint>
                </div>
                <RadioRow>
                    {([0, 1, 2] as const).map((t) => (
                        <RadioOption key={t}>
                            <input
                                type="radio"
                                name="ai-tier"
                                value={t}
                                checked={draft.tier === t}
                                onChange={() => setDraft((d) => ({ ...d, tier: t }))}
                                disabled={busy}
                            />
                            {TIER_DESCRIPTIONS[t]}
                        </RadioOption>
                    ))}
                </RadioRow>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel>MCP Required</FieldLabel>
                    <FieldHint>
                        When on, chat is gated behind the MCP health probe.
                        Turn off to run in MCP-less chat mode (streaming-only,
                        no tool dispatch — useful while you set up the MCP
                        Server).
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.mcp_required}
                        onChange={(e) =>
                            setDraft((d) => ({
                                ...d,
                                mcp_required: e.target.checked,
                            }))
                        }
                        disabled={busy}
                    />
                    {draft.mcp_required ? 'Required' : 'Optional'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-mcp-url">MCP Server URL</FieldLabel>
                    <FieldHint>
                        Splunk MCP Server endpoint. Leave blank to use the
                        default <code>/en-US/splunkd/__raw/services/mcp</code>{' '}
                        on this Splunk instance.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-mcp-url"
                    type="text"
                    value={draft.mcp_server_url}
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            mcp_server_url: e.target.value,
                        }))
                    }
                    placeholder="(leave blank to use default)"
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <SectionHeading>Limits &amp; Quotas</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-rate-limit">
                        Rate limit (free-form prompts/hour)
                    </FieldLabel>
                    <FieldHint>
                        Per-user cap on free-form chat prompts in a rolling 1-hour
                        window. Predefined-prompt (Browse prompts) executions
                        do not count. Set to <code>0</code> to disable. Higher
                        thresholds reduce the protection against runaway scripts;
                        lower thresholds may interfere with legitimate heavy
                        users. Default <code>30</code>.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-rate-limit"
                    type="number"
                    min={0}
                    max={10000}
                    step={1}
                    value={String(draft.rate_limit_per_hour)}
                    onChange={(e) => {
                        const n = Number(e.target.value);
                        setDraft((d) => ({
                            ...d,
                            rate_limit_per_hour: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
                        }));
                    }}
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-tool-cap">
                        Session tool-call cap
                    </FieldLabel>
                    <FieldHint>
                        Per-chat-session cap on the total number of MCP tool
                        dispatches (saved-search runs + ad-hoc SPL queries) the
                        AI Assistant may issue across all messages. Resets when
                        the user clears the chat. Defense-in-depth above the
                        per-message limit of 8 tool turns. Set to <code>0</code>
                        to disable. Default <code>100</code> — well above
                        normal investigative use; bites only on runaway loops.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-tool-cap"
                    type="number"
                    min={0}
                    max={100000}
                    step={1}
                    value={String(draft.tool_calls_per_session_cap)}
                    onChange={(e) => {
                        const n = Number(e.target.value);
                        setDraft((d) => ({
                            ...d,
                            tool_calls_per_session_cap: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
                        }));
                    }}
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-daily-spend-cap">
                        Daily spend cap (USD)
                    </FieldLabel>
                    <FieldHint>
                        Per-user daily AI vendor spend cap in USD. Tally is the
                        sum of vendor-reported token cost across all of the
                        user's free-form prompts; resets at local midnight.
                        When reached, all subsequent prompts are refused with
                        an in-chat notice. Predefined-prompt executions don't
                        accumulate spend. Set to <code>0</code> to disable.
                        Default <code>50.00</code> — generous for active
                        investigative use on Sonnet/Haiku, tighter on Opus
                        where one large prompt can cost a dollar; tune to your
                        model + budget posture.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-daily-spend-cap"
                    type="number"
                    min={0}
                    max={1000000}
                    step={0.01}
                    value={String(draft.daily_spend_cap_usd)}
                    onChange={(e) => {
                        const n = Number(e.target.value);
                        setDraft((d) => ({
                            ...d,
                            daily_spend_cap_usd: Number.isFinite(n) && n >= 0 ? n : 0,
                        }));
                    }}
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <SectionHeading>Privacy</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Tier 2 PII column redaction</FieldLabel>
                    <FieldHint>
                        When on (default), Tier 2 categorical aggregates
                        replace identifier-class column values
                        (<code>user</code>, <code>email</code>,{' '}
                        <code>src_ip</code>, <code>dest_ip</code>,{' '}
                        <code>mac</code>, <code>account</code>) with stable{' '}
                        <code>&lt;redacted-XXXXXXX&gt;</code> tags before the
                        summary crosses the privacy boundary to the AI
                        vendor. Cardinality + frequency are preserved (top-N
                        counts are real); only the value names get scrubbed.
                        Has no effect at Tier 0/1. Defense-in-depth on top
                        of the type-system <code>Hidden&lt;T&gt;</code>{' '}
                        boundary that already prevents raw rows from
                        leaving the browser.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.tier2_pii_redaction}
                        onChange={(e) =>
                            setDraft((d) => ({
                                ...d,
                                tier2_pii_redaction: e.target.checked,
                            }))
                        }
                        disabled={busy}
                    />
                    {draft.tier2_pii_redaction ? 'Redact identifiers' : 'Send raw values'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel>Tier 2 hostname redaction</FieldLabel>
                    <FieldHint>
                        When on, also redact <code>host</code> /{' '}
                        <code>hostname</code> columns under the same
                        scheme. Off by default — Splunk dashboards
                        routinely show hostnames and most admins expect
                        them visible to the AI for triage. Turn on for
                        the strictest privacy posture (multi-tenant or
                        government-tenant deployments where host names
                        are themselves identifying).
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.tier2_redact_hostnames}
                        onChange={(e) =>
                            setDraft((d) => ({
                                ...d,
                                tier2_redact_hostnames: e.target.checked,
                            }))
                        }
                        disabled={busy || !draft.tier2_pii_redaction}
                    />
                    {draft.tier2_redact_hostnames ? 'Redact hostnames' : 'Send hostnames'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <SectionHeading>Power Users</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Power Mode roles</FieldLabel>
                    <FieldHint>
                        Splunk roles whose members see the AI Assistant
                        &quot;Power Mode&quot; toggle in the chat input
                        toolbar. When that toggle is on, every free-form
                        prompt forces a saved-search dispatch BEFORE the
                        AI generates its response — effectively
                        forced-RAG for trusted analysts. Configuration is
                        intentionally role-based, not user-based.
                        Empty (default) hides the toggle for everyone.
                        For full data-grounded answers also set{' '}
                        <code>tier=2</code> so the AI sees aggregated
                        values from the forced dispatch.
                    </FieldHint>
                </div>
                <div>
                    {rolesLoaded && availableRoles.length > 0 ? (
                        <Multiselect
                            compact
                            inline
                            filter
                            selectAllAppearance="checkbox"
                            showSelectedValuesFirst="nextOpen"
                            placeholder={
                                parsePowerUserRoles(draft.power_user_roles).length === 0
                                    ? `Pick roles (${availableRoles.length} available)`
                                    : undefined
                            }
                            values={parsePowerUserRoles(draft.power_user_roles)}
                            onChange={(_e, { values }) => {
                                const csv = values
                                    .map((v) => String(v))
                                    .filter((s) => s.length > 0)
                                    .join(',');
                                setDraft((d) => ({ ...d, power_user_roles: csv }));
                            }}
                            disabled={busy}
                            style={{ minWidth: 280, maxWidth: 480 }}
                        >
                            {availableRoles.map((r) => (
                                <Multiselect.Option key={r} label={r} value={r} />
                            ))}
                        </Multiselect>
                    ) : (
                        <FieldHint>Loading roles…</FieldHint>
                    )}
                </div>
                <span />
            </FieldRow>

            <SectionHeading>Audit &amp; Telemetry</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-audit-index-name">
                        Audit index name
                    </FieldLabel>
                    <FieldHint>
                        Splunk index that receives every audit event. The
                        default <code>ai_assistant_audit</code> matches the
                        LogServ Index App's defaults. To rename, also update
                        the <code>sap_logserv_audit_idx_macro</code> macro
                        definition (Settings → Advanced search → Search
                        macros) so the in-app Audit Log viewer reads from
                        the same index. The conf field controls writes; the
                        macro controls reads — keep them aligned.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-audit-index-name"
                    type="text"
                    value={draft.audit_index_name}
                    placeholder="logserv_ai_assistant_audit"
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            audit_index_name: e.target.value,
                        }))
                    }
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel>Audit log forwarder</FieldLabel>
                    <FieldHint>
                        When on, every audit event recorded locally is
                        also dual-written to the HEC endpoint configured
                        below. The destination should live on a different
                        host, owned by a different admin team — that is
                        what makes this a tamper-evidence control. When
                        off, an admin with shell access to this host can
                        edit audit events directly. Disabling this
                        setting opens an acknowledgement dialog at save
                        time. Token is configured under{' '}
                        <strong>Splunk MCP → Audit Log Forwarder</strong>.
                        The destination HEC must allow CORS from this
                        Splunk Web origin.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={draft.audit_forwarder_enabled}
                        onChange={(e) =>
                            setDraft((d) => ({
                                ...d,
                                audit_forwarder_enabled: e.target.checked,
                            }))
                        }
                        disabled={busy}
                    />
                    {draft.audit_forwarder_enabled ? 'Forwarding' : 'Local-only'}
                </ToggleLabel>
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-forwarder-url">
                        Forwarder HEC URL
                    </FieldLabel>
                    <FieldHint>
                        Base URL of the destination Splunk / SIEM HEC, up
                        to but not including <code>/services/collector/event</code>.
                        Example: <code>https://siem.example.com:8088</code>.
                        Required when forwarding is enabled.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-forwarder-url"
                    type="text"
                    value={draft.audit_forwarder_url}
                    placeholder="https://siem.example.com:8088"
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            audit_forwarder_url: e.target.value,
                        }))
                    }
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-forwarder-index">
                        Forwarder remote index (optional)
                    </FieldLabel>
                    <FieldHint>
                        Splunk index name on the destination side. Leave
                        blank to use the HEC token's default. Common
                        practice is to mirror our local index name (
                        <code>ai_assistant_audit</code>).
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-forwarder-index"
                    type="text"
                    value={draft.audit_forwarder_index}
                    placeholder="(use HEC token default)"
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            audit_forwarder_index: e.target.value,
                        }))
                    }
                    disabled={busy}
                />
                <span />
            </FieldRow>

            <FieldRow>
                <div>
                    <FieldLabel htmlFor="ai-forwarder-source">
                        Forwarder source field
                    </FieldLabel>
                    <FieldHint>
                        Source name stamped on every forwarded event.
                        Distinguishes forwarded copies from native locally-
                        ingested events when both end up in the same
                        destination index. Default{' '}
                        <code>logserv_ai_assistant_remote</code>.
                    </FieldHint>
                </div>
                <FieldInput
                    id="ai-forwarder-source"
                    type="text"
                    value={draft.audit_forwarder_source}
                    onChange={(e) =>
                        setDraft((d) => ({
                            ...d,
                            audit_forwarder_source: e.target.value,
                        }))
                    }
                    disabled={busy}
                />
                <span />
            </FieldRow>

            {opError && (
                <FieldRow>
                    <span />
                    <FieldStatus $tone="error">{opError}</FieldStatus>
                    <span />
                </FieldRow>
            )}

            <GeneralActionsRow>
                <Button type="button" onClick={handleRevert} disabled={busy || !dirty}>
                    Revert
                </Button>
                <Button
                    type="button"
                    $variant="primary"
                    onClick={handleSave}
                    disabled={busy || !dirty}
                >
                    {busy ? 'Saving…' : 'Save Defaults'}
                </Button>
            </GeneralActionsRow>

            <AiAssistantEnableAcceptanceModal
                open={enableModalOpen}
                adminUsername={adminUsername}
                providerName={draft.provider}
                previousEnabledState={saved.enabled}
                tcVersion={enableTcState.optInVersion}
                onChoice={handleEnableChoice}
                busy={busy}
            />
            <ForwarderDisabledAcceptanceModal
                open={forwarderModalOpen}
                adminUsername={adminUsername}
                previousEnabledState={saved.audit_forwarder_enabled}
                tcVersion={forwarderTcState.optInVersion}
                onChoice={handleForwarderChoice}
                busy={busy}
            />
        </>
    );
};

// ─── single-field row ─────────────────────────────────────────────────────
const FieldEditor: React.FC<{ field: FieldDef; onSaved: () => void; }> = ({
    field,
    onSaved,
}) => {
    const [summary, setSummary] = useState<CredentialSummary | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [draft, setDraft] = useState<string>('');
    const [busy, setBusy] = useState<'idle' | 'saving' | 'deleting'>('idle');
    const [opError, setOpError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const s = await readCredentialSummary(field.realm, field.name);
            setSummary(s);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        }
    }, [field.realm, field.name]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const validateDraft = (): string | null => {
        if (!draft) return null; // empty is "no change"
        if (field.minLength != null && draft.length < field.minLength) {
            return `Value too short — expected at least ${field.minLength} characters, got ${draft.length}.`;
        }
        if (field.expectedPrefix && !draft.startsWith(field.expectedPrefix)) {
            return `Value must start with "${field.expectedPrefix}".`;
        }
        return null;
    };

    const handleSave = async (): Promise<void> => {
        const err = validateDraft();
        if (err) {
            setOpError(err);
            return;
        }
        if (!draft) {
            setOpError('Enter a value before saving.');
            return;
        }
        setBusy('saving');
        setOpError(null);
        try {
            await writeCredential(field.realm, field.name, draft);
            setDraft('');
            await refresh();
            onSaved();
        } catch (e) {
            setOpError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy('idle');
        }
    };

    const handleClear = async (): Promise<void> => {
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Delete the stored ${field.label} for ${field.realm}?`)) return;
        setBusy('deleting');
        setOpError(null);
        try {
            await deleteCredential(field.realm, field.name);
            await refresh();
            onSaved();
        } catch (e) {
            setOpError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy('idle');
        }
    };

    const renderStatus = (): React.ReactNode => {
        if (loadError) {
            return <FieldStatus $tone="error">Read error: {loadError}</FieldStatus>;
        }
        if (!summary) {
            return <FieldStatus $tone="absent">Loading…</FieldStatus>;
        }
        if (!summary.exists) {
            return <FieldStatus $tone="absent">Not set</FieldStatus>;
        }
        return (
            <FieldStatus $tone="good">
                Stored: length {summary.length}
                {field.showPrefix && summary.prefix
                    ? `, prefix "${summary.prefix}…"`
                    : ''}
            </FieldStatus>
        );
    };

    return (
        <FieldRow>
            <div>
                <FieldLabel htmlFor={`${field.realm}__${field.name}`}>{field.label}</FieldLabel>
                <FieldHint>{field.hint}</FieldHint>
                {renderStatus()}
                {opError && <FieldStatus $tone="error">{opError}</FieldStatus>}
            </div>
            <FieldInput
                id={`${field.realm}__${field.name}`}
                type="password"
                placeholder={summary?.exists ? '(leave blank to keep current)' : 'Enter new value'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy !== 'idle'}
                autoComplete="new-password"
            />
            <ButtonRow>
                <Button
                    type="button"
                    $variant="primary"
                    onClick={handleSave}
                    disabled={busy !== 'idle' || !draft}
                >
                    {busy === 'saving' ? 'Saving…' : summary?.exists ? 'Update' : 'Save'}
                </Button>
                <Button
                    type="button"
                    $variant="danger"
                    onClick={handleClear}
                    disabled={busy !== 'idle' || !summary?.exists}
                >
                    {busy === 'deleting' ? 'Clearing…' : 'Clear'}
                </Button>
            </ButtonRow>
        </FieldRow>
    );
};

// ─── top-level page ───────────────────────────────────────────────────────
interface AIAssistantSettingsProps {
    /** Callback fired by GeneralPanel after a successful
     *  `writeAIConfig`. Bubbled up to App.tsx so the cached
     *  AIAssistantConfig is refreshed and downstream UI (the
     *  AI Assistant button + side panel + privacy banner)
     *  reacts immediately to the saved change without a page
     *  reload. Build 101 / session 022. */
    onConfigSaved?: () => Promise<void> | void;
    /** Runtime templates-only mode from AIAssistantConfig. When true,
     *  the Provider Credentials tab is hidden and a top-of-page banner
     *  explains that LLM dispatch is disabled. Updates live on Settings
     *  save via the App.tsx → AppShell → AIAssistantSettings prop chain. */
    templatesOnlyMode?: boolean;
}

const AIAssistantSettings: React.FC<AIAssistantSettingsProps> = ({
    onConfigSaved,
    templatesOnlyMode = false,
}) => {
    const { isAdmin, loading, username, error } = useIsAdmin();
    const [savedTick, setSavedTick] = useState<number>(0);
    const [globalNotice, setGlobalNotice] = useState<string | null>(null);

    useEffect(() => {
        if (savedTick > 0) {
            setGlobalNotice('Saved.');
            const t = window.setTimeout(() => setGlobalNotice(null), 4000);
            return () => window.clearTimeout(t);
        }
        return undefined;
    }, [savedTick]);

    if (loading) {
        return (
            <DashboardLayout
                category="SETTINGS"
                title="AI Assistant"
                subtitle="Loading…"
            >
                <div />
            </DashboardLayout>
        );
    }

    if (error) {
        return (
            <DashboardLayout
                category="SETTINGS"
                title="AI Assistant"
                subtitle="Could not determine the current user's role"
            >
                <ForbiddenBlock>
                    <strong>Error:</strong> {error.message}
                </ForbiddenBlock>
            </DashboardLayout>
        );
    }

    if (!isAdmin) {
        return (
            <DashboardLayout
                category="SETTINGS"
                title="AI Assistant"
                subtitle="Access restricted"
            >
                <ForbiddenBlock>
                    <strong>403 — Admin access required.</strong>
                    <div style={{ marginTop: 8 }}>
                        Signed in as <code>{username ?? 'unknown'}</code>. The AI
                        Assistant configuration page is only available to users
                        with the <code>admin</code> role. Contact your Splunk
                        administrator for access, or sign in with an admin
                        account.
                    </div>
                </ForbiddenBlock>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout
            category="SETTINGS"
            title="AI Assistant"
            subtitle="Configure LLM provider credentials and the Splunk MCP Server connection. All values are stored in Splunk's encrypted password store; this page only ever displays length + prefix, never the cleartext."
        >
            {globalNotice && <StatusBanner $tone="success">{globalNotice}</StatusBanner>}

            {templatesOnlyMode && (
                <StatusBanner $tone="info">
                    Templates-only mode — LLM dispatch is disabled by admin setting. Provider /
                    model / tier / Power-Mode fields on this page have NO effect while this mode
                    is on. The Provider Credentials tab is hidden. The MCP server connection
                    (Splunk MCP tab) and the Audit Log remain fully active. Toggle templates-only
                    mode off in the General tab to re-enable LLM dispatch.
                </StatusBanner>
            )}

            <TabLayout defaultActivePanelId="general">
                <TabLayout.Panel
                    panelId="general"
                    label="General"
                >
                    <SectionGrid>
                        <FramedPanel
                            title="General"
                            subtitle="Org-wide AI Assistant defaults: enable/disable, active provider, default model, privacy tier, MCP gate, server URL, and per-user rate limit. These apply to every user of this app."
                        >
                            <GeneralPanel
                                onSaved={() => setSavedTick((n) => n + 1)}
                                adminUsername={username ?? ''}
                                onConfigSaved={onConfigSaved}
                            />
                        </FramedPanel>
                    </SectionGrid>
                </TabLayout.Panel>

                {!templatesOnlyMode && (
                    <TabLayout.Panel
                        panelId="providers"
                        label="Provider Credentials"
                    >
                        <SectionGrid>
                            {PROVIDER_FIELDS.map((section) => (
                                <FramedPanel
                                    key={section.sectionTitle}
                                    title={section.sectionTitle}
                                    subtitle={section.subtitle}
                                >
                                    {section.fields.map((f) => (
                                        <FieldEditor
                                            key={`${f.realm}::${f.name}`}
                                            field={f}
                                            onSaved={() => setSavedTick((n) => n + 1)}
                                        />
                                    ))}
                                </FramedPanel>
                            ))}
                        </SectionGrid>
                    </TabLayout.Panel>
                )}

                <TabLayout.Panel
                    panelId="mcp"
                    label="Splunk MCP"
                >
                    <SectionGrid>
                        <FramedPanel
                            title="Splunk MCP Server"
                            subtitle="Bearer token for the Splunk MCP Server. The server URL itself lives under General. Phase G replaces the manual token paste with auto-mint via OAuth/RSA on the Data TA."
                        >
                            {MCP_FIELDS.map((f) => (
                                <FieldEditor
                                    key={`${f.realm}::${f.name}`}
                                    field={f}
                                    onSaved={() => setSavedTick((n) => n + 1)}
                                />
                            ))}
                        </FramedPanel>
                        <FramedPanel
                            title="Audit Log Forwarder"
                            subtitle="HEC token for tamper-evident audit forwarding to a separate Splunk / SIEM. Configure the destination URL and on/off toggle under General. Token is sent on every audit-event POST as `Authorization: Splunk <token>`."
                        >
                            {AUDIT_FORWARDER_FIELDS.map((f) => (
                                <FieldEditor
                                    key={`${f.realm}::${f.name}`}
                                    field={f}
                                    onSaved={() => setSavedTick((n) => n + 1)}
                                />
                            ))}
                        </FramedPanel>
                    </SectionGrid>
                </TabLayout.Panel>

                <TabLayout.Panel
                    panelId="audit"
                    label="Audit Log"
                >
                    <SectionGrid>
                        <FramedPanel
                            title="AI Assistant Audit Log"
                            subtitle="Read-only browser of every audit event recorded by the AI Assistant — local-only canned prompts, vendor calls, security blocks, and privacy-tier elevations. Filter by time range, category, and user. Click + to expand a row's full event JSON. The disclaimer below describes the tamper-resistance threat model."
                        >
                            <AuditLogViewer />
                        </FramedPanel>
                    </SectionGrid>
                </TabLayout.Panel>

                <TabLayout.Panel
                    panelId="topology"
                    label="Topology"
                >
                    <SectionGrid>
                        <FramedPanel
                            title="Environment Topology Aggregation"
                            subtitle="Admin controls for the time-bucketed KV Store that powers the Environment Topology view. Hourly scheduled searches aggregate node + edge activity into the logserv_topology_nodes + logserv_topology_edges collections; the topology view reads from KV Store at render time, filtered by the global TimeRange picker. Built session 035 / build 188 — see topology_kvstore_design_v0.1.md for the full architecture."
                        >
                            <TopologySettingsPanel />
                        </FramedPanel>
                    </SectionGrid>
                </TabLayout.Panel>
            </TabLayout>
        </DashboardLayout>
    );
};

export default AIAssistantSettings;
