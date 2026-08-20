import React, { Suspense, lazy, useCallback, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import styled from 'styled-components';
import { variables } from '@splunk/themes';
import NavigationBar from './NavigationBar';
import PlaceholderDashboard from './PlaceholderDashboard';
import { dashboards } from '../routes/dashboardRegistry';
import { logservTheme } from '../styles/logservTheme';
import { GlobalRefreshProvider } from '../state/GlobalRefreshProvider';
import { DiagnosticDrawerProvider } from '../state/DiagnosticDrawerProvider';
import { AIAssistant, SidePanel } from './ai/chat';

const SESSION_KEY_AI_PANEL_OPEN = 'logserv.aiAssistant.sidePanel.expanded';

const readBoolFromSession = (key: string, fallback: boolean): boolean => {
    try {
        const v = window.sessionStorage.getItem(key);
        if (v === 'true') return true;
        if (v === 'false') return false;
    } catch (_e) { /* ignore */ }
    return fallback;
};

const writeBoolToSession = (key: string, value: boolean): void => {
    try {
        window.sessionStorage.setItem(key, String(value));
    } catch (_e) { /* ignore */ }
};

// Lazy-load each real dashboard so it ships as its own webpack chunk.
// Dashboards that don't pull in Highcharts (via @splunk/visualizations) stay
// small; only the routes that need it pay the bundle cost on first navigation.
const EnvironmentHealth = lazy(() => import('../dashboards/EnvironmentHealth'));
const WebDispatcher = lazy(() => import('../dashboards/WebDispatcher'));
const Linux = lazy(() => import('../dashboards/Linux'));
const CloudConnector = lazy(() => import('../dashboards/CloudConnector'));
const Proxy = lazy(() => import('../dashboards/Proxy'));
const DnsAnalytics = lazy(() => import('../dashboards/DnsAnalytics'));
const HanaAudit = lazy(() => import('../dashboards/HanaAudit'));
const Windows = lazy(() => import('../dashboards/Windows'));
const HanaTrace = lazy(() => import('../dashboards/HanaTrace'));
const SapServices = lazy(() => import('../dashboards/SapServices'));
const SapRouter = lazy(() => import('../dashboards/SapRouter'));
const AbapSecurity = lazy(() => import('../dashboards/AbapSecurity'));
const AbapOperations = lazy(() => import('../dashboards/AbapOperations'));
const WorkProcessPerformance = lazy(() => import('../dashboards/WorkProcessPerformance'));
const WebApiPerformance = lazy(() => import('../dashboards/WebApiPerformance'));
const NetworkPerimeter = lazy(() => import('../dashboards/NetworkPerimeter'));
const CrossStackAuthentication = lazy(() => import('../dashboards/CrossStackAuthentication'));
const ChangeConfig = lazy(() => import('../dashboards/ChangeConfig'));
const DataPipelineOverview = lazy(() => import('../dashboards/DataPipelineOverview'));
const HostDetails = lazy(() => import('../dashboards/HostDetails'));
const IntegrationTopology = lazy(() => import('../dashboards/IntegrationTopology'));
const MultiCloudOverview = lazy(() => import('../dashboards/MultiCloudOverview'));
const AIAssistantSettings = lazy(() => import('../dashboards/AIAssistantSettings'));
const Diagnostics = lazy(() => import('../dashboards/Diagnostics'));

const Page = styled.div`
    min-height: 100vh;
    background: ${logservTheme.colors.pageBackground};
    color: ${logservTheme.colors.textActive};
    /* Magnetic body stack (Phase 1b, build 254) — Inter first, Splunk Web's
       own stack as the fallback (both directly and via the appended
       variables.fontFamily) so a failed font load degrades gracefully. */
    font-family: ${logservTheme.font.body}, ${variables.fontFamily};

    /* Force descendants (h1-h6, buttons, inputs, code) to inherit the page
       font family — they don't inherit by default. Without this rule, headings
       and buttons fall back to the browser default serif. */
    button, input, select, textarea, h1, h2, h3, h4, h5, h6, code, pre, kbd, samp {
        font-family: inherit;
    }

    /* Code/SPL elements get the Magnetic mono stack (Roboto Mono). Declared
       AFTER the inherit rule above so it wins at equal specificity. */
    code, pre, kbd, samp {
        font-family: ${logservTheme.font.mono};
    }

    /* Splunk Web's page-level stylesheet (set once by layout() at load) styles
       raw text elements DIRECTLY (e.g. dark-chrome p { color: <near-white> }),
       which beats inheritance. When the user runtime-toggles our mode away
       from the chrome theme, that leaves white text on white cards (or vice
       versa) — Phase 1a bug on Multi-Cloud Overview's info panel. Class-scoped
       inherit (0,1,1) outranks the global element rules so text always follows
       our token-driven parent color. Deliberately EXCLUDES span/button/input —
       @splunk/react-ui components own those. Build 248. */
    p, li, strong, em, code, pre, kbd, samp, blockquote {
        color: inherit;
    }

    /* @splunk/visualizations (Highcharts) tooltips ship their own legacy
       chrome (dark #27292e box in dark, gray bevel in light) set as SVG
       presentation ATTRIBUTES — plain CSS rules outrank those, so this
       restyles every chart tooltip to match our token-styled Sparkline
       tooltip in BOTH modes (user request, build 249). The :not([fill="none"])
       guard leaves the stacked shadow paths alone; the span/div rules cover
       Highcharts' useHTML tooltip variant (inline-styled → !important). */
    .highcharts-tooltip path.highcharts-tooltip-box:not([fill='none']) {
        /* !important beats any stray inline style.fill left by a pre-build-251
           GradientWrap pass within the same page session. */
        fill: ${logservTheme.colors.tableHeaderBackground} !important;
        stroke: ${logservTheme.colors.panelBorder} !important;
    }
    /* Kill the 3 stacked black-stroke shadow layers so chart tooltips are
       indistinguishable from the (shadow-less) Sparkline tooltip. Build 250. */
    .highcharts-tooltip path.highcharts-shadow[fill='none'] {
        display: none;
    }
    .highcharts-tooltip text,
    .highcharts-tooltip tspan {
        fill: ${logservTheme.colors.textActive} !important;
    }
    div.highcharts-tooltip,
    div.highcharts-tooltip span,
    .highcharts-tooltip span {
        color: ${logservTheme.colors.textActive} !important;
    }
`;

const SuspenseFallback = styled.div`
    padding: ${logservTheme.spacing.xxl};
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

interface AppShellProps {
    /** From AIAssistantConfig.enabled — gates the AI Assistant UI on/off. */
    aiAssistantEnabled?: boolean;
    /** From AIAssistantConfig.templatesOnlyMode — when true, disables the
     *  free-form / LLM-driven path at runtime: read-only chat input,
     *  hidden model picker / Power Mode toggle, hidden Provider
     *  Credentials Settings tab. Predefined-prompt path stays active.
     *  Replaces the prior compile-time TEMPLATES_ONLY build flag. */
    aiAssistantTemplatesOnlyMode?: boolean;
    /** From AIAssistantConfig.tier — passed to the chat for the privacy banner. */
    aiAssistantTier?: 0 | 1 | 2;
    /** From AIAssistantConfig.mcpRequired — when false, bypasses MCP health gate. */
    aiAssistantMcpRequired?: boolean;
    /** From AIAssistantConfig.rateLimitPerHour — per-user free-form prompt
     *  cap (rolling 1-hour window). 0 disables. Build 80 / session 019. */
    aiAssistantRateLimitPerHour?: number;
    /** From AIAssistantConfig.toolCallsPerSessionCap — per-chat-session
     *  cap on total MCP tool dispatches across all messages. 0 disables.
     *  Build 88 / session 020. */
    aiAssistantToolCallsPerSessionCap?: number;
    /** From AIAssistantConfig.dailySpendCapUsd — per-user daily vendor
     *  spend cap in USD (resets at local midnight). 0 disables.
     *  Build 89 / session 020. */
    aiAssistantDailySpendCapUsd?: number;
    /** From AIAssistantConfig.tier2PiiRedaction — when true (default),
     *  Tier 2 categorical aggregates redact identifier-class column
     *  values before they cross the privacy boundary. Maps to OWASP
     *  LLM02. Build 94 / session 022. */
    aiAssistantTier2PiiRedaction?: boolean;
    /** From AIAssistantConfig.tier2RedactHostnames — when true, also
     *  redact host / hostname columns. Default false. Build 94 / s022. */
    aiAssistantTier2RedactHostnames?: boolean;
    /** From AIAssistantConfig.powerUserRoles — CSV of Splunk role names
     *  whose members see the Power Mode toggle in the chat input.
     *  Build 166 / session 028. */
    aiAssistantPowerUserRoles?: string;
    /** Callback invoked by the AI Assistant Settings page after a
     *  successful `writeAIConfig`. App-level handler re-reads the
     *  conf and updates the cached AIAssistantConfig so the
     *  AI Assistant button + side panel react immediately to the
     *  saved change (e.g. when admin disables the feature, the
     *  button vanishes without a manual page refresh).
     *  Build 101 / session 022. */
    onAIConfigSaved?: () => Promise<void> | void;
}

const AppShell: React.FC<AppShellProps> = ({
    aiAssistantEnabled = false,
    aiAssistantTemplatesOnlyMode = false,
    aiAssistantTier = 1,
    aiAssistantMcpRequired = true,
    aiAssistantRateLimitPerHour = 30,
    aiAssistantToolCallsPerSessionCap = 100,
    aiAssistantDailySpendCapUsd = 50.0,
    aiAssistantTier2PiiRedaction = true,
    aiAssistantTier2RedactHostnames = false,
    aiAssistantPowerUserRoles = '',
    onAIConfigSaved,
}) => {
    const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(() =>
        aiAssistantEnabled ? readBoolFromSession(SESSION_KEY_AI_PANEL_OPEN, false) : false,
    );
    const toggleAiPanel = useCallback((): void => {
        setAiPanelOpen((prev) => {
            const next = !prev;
            writeBoolToSession(SESSION_KEY_AI_PANEL_OPEN, next);
            return next;
        });
    }, []);
    const closeAiPanel = useCallback((): void => {
        setAiPanelOpen(false);
        writeBoolToSession(SESSION_KEY_AI_PANEL_OPEN, false);
    }, []);

    return (
        <Page>
            <GlobalRefreshProvider>
            {/* Session 095 — one app-level diagnosis drawer, portaled to
                document.body. Mounted here so every panel on every route can
                open it, and so only ONE can ever be open: the failure this
                diagnoses empties every panel at once, and per-panel drawers
                would let an operator multiply the load on an instance they are
                trying to rescue. */}
            <DiagnosticDrawerProvider>
                <NavigationBar
                    onToggleAIAssistant={aiAssistantEnabled ? toggleAiPanel : undefined}
                    aiAssistantOpen={aiPanelOpen}
                />
            {aiAssistantEnabled && (
                <SidePanel
                    templatesOnlyMode={aiAssistantTemplatesOnlyMode}
                    tier={aiAssistantTier}
                    mcpRequired={aiAssistantMcpRequired}
                    rateLimitPerHour={aiAssistantRateLimitPerHour}
                    toolCallsPerSessionCap={aiAssistantToolCallsPerSessionCap}
                    dailySpendCapUsd={aiAssistantDailySpendCapUsd}
                    tier2PiiRedaction={aiAssistantTier2PiiRedaction}
                    tier2RedactHostnames={aiAssistantTier2RedactHostnames}
                    powerUserRoles={aiAssistantPowerUserRoles}
                    expanded={aiPanelOpen}
                    onClose={closeAiPanel}
                />
            )}
            <Suspense fallback={<SuspenseFallback>Loading dashboard…</SuspenseFallback>}>
                <Routes>
                    <Route path="/" element={<EnvironmentHealth />} />
                    <Route path="/integration/web-dispatcher" element={<WebDispatcher />} />
                    <Route path="/platform/linux" element={<Linux />} />
                    <Route path="/integration/cloud-connector" element={<CloudConnector />} />
                    <Route path="/platform/proxy" element={<Proxy />} />
                    <Route path="/platform/dns-analytics" element={<DnsAnalytics />} />
                    <Route path="/applications/hana-audit" element={<HanaAudit />} />
                    <Route path="/platform/windows" element={<Windows />} />
                    <Route path="/applications/hana-trace" element={<HanaTrace />} />
                    <Route path="/integration/sap-services" element={<SapServices />} />
                    <Route path="/integration/sap-router" element={<SapRouter />} />
                    <Route path="/applications/abap-security" element={<AbapSecurity />} />
                    <Route path="/applications/abap-operations" element={<AbapOperations />} />
                    <Route path="/applications/work-process-performance" element={<WorkProcessPerformance />} />
                    <Route path="/integration/web-api-performance" element={<WebApiPerformance />} />
                    <Route path="/security/network-perimeter" element={<NetworkPerimeter />} />
                    <Route path="/security/cross-stack-authentication" element={<CrossStackAuthentication />} />
                    <Route path="/security/change-config" element={<ChangeConfig />} />
                    <Route path="/platform/data-pipeline-overview" element={<DataPipelineOverview />} />
                    <Route path="/platform/host-details" element={<HostDetails />} />
                    <Route path="/topology/integration-topology" element={<IntegrationTopology />} />
                    <Route path="/platform/multi-cloud-overview" element={<MultiCloudOverview />} />
                    <Route path="/diagnostics" element={<Diagnostics />} />
                    <Route path="/settings" element={<AIAssistantSettings onConfigSaved={onAIConfigSaved} templatesOnlyMode={aiAssistantTemplatesOnlyMode} />} />
                    {/* back-compat redirect — old bookmarks / help-icon links to the
                        pre-build-245 route still land on the renamed Settings page. */}
                    <Route path="/settings/ai-assistant" element={<Navigate to="/settings" replace />} />
                    {aiAssistantEnabled && (
                        <Route
                            path="/ai-assistant"
                            element={
                                <AIAssistant
                                    templatesOnlyMode={aiAssistantTemplatesOnlyMode}
                                    tier={aiAssistantTier}
                                    mcpRequired={aiAssistantMcpRequired}
                                    rateLimitPerHour={aiAssistantRateLimitPerHour}
                                    toolCallsPerSessionCap={aiAssistantToolCallsPerSessionCap}
                                    dailySpendCapUsd={aiAssistantDailySpendCapUsd}
                                    tier2PiiRedaction={aiAssistantTier2PiiRedaction}
                                    tier2RedactHostnames={aiAssistantTier2RedactHostnames}
                                    powerUserRoles={aiAssistantPowerUserRoles}
                                />
                            }
                        />
                    )}
                    {dashboards
                        .filter(
                            (d) =>
                                d.path !== '/' &&
                                d.path !== '/integration/web-dispatcher' &&
                                d.path !== '/platform/linux' &&
                                d.path !== '/integration/cloud-connector' &&
                                d.path !== '/platform/proxy' &&
                                d.path !== '/platform/dns-analytics' &&
                                d.path !== '/applications/hana-audit' &&
                                d.path !== '/platform/windows' &&
                                d.path !== '/applications/hana-trace' &&
                                d.path !== '/integration/sap-services' &&
                                d.path !== '/integration/sap-router' &&
                                d.path !== '/applications/abap-security' &&
                                d.path !== '/applications/abap-operations' &&
                                d.path !== '/applications/work-process-performance' &&
                                d.path !== '/integration/web-api-performance' &&
                                d.path !== '/security/network-perimeter' &&
                                d.path !== '/security/cross-stack-authentication' &&
                                d.path !== '/security/change-config' &&
                                d.path !== '/platform/data-pipeline-overview' &&
                                d.path !== '/platform/host-details' &&
                                d.path !== '/topology/integration-topology' &&
                                d.path !== '/platform/multi-cloud-overview' &&
                                d.path !== '/diagnostics'
                        )
                        .map((d) => (
                            <Route
                                key={d.slug}
                                path={d.path}
                                element={<PlaceholderDashboard dashboard={d} />}
                            />
                        ))}
                    <Route path="*" element={<PlaceholderDashboard fallback />} />
                </Routes>
            </Suspense>
            </DiagnosticDrawerProvider>
            </GlobalRefreshProvider>
        </Page>
    );
};

export default AppShell;
