import React, { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { ChartPalette } from '../../../styles/chartPalettes';
import { findDashboardByPath } from '../../../routes/dashboardRegistry';
import intentMap from '../../../../../../resources/splunk/default/data/mcp/logserv_intent_map.json';

/**
 * Time range options for predefined prompts. Each entry is sent to the
 * MCP server as `earliest_time` / `latest_time`; the saved search's own
 * `earliest=...` SPL clause is overridden by the dispatch tokens, so a
 * "last 7 days" pick on a 24h-baked saved search just widens the window.
 */
export interface TimeRangeOption {
    id: string;
    label: string;
    earliest: string;
    latest: string;
}

export const TIME_RANGE_OPTIONS: ReadonlyArray<TimeRangeOption> = [
    { id: '1h',  label: 'Last 1 hour',   earliest: '-1h',  latest: 'now' },
    { id: '4h',  label: 'Last 4 hours',  earliest: '-4h',  latest: 'now' },
    { id: '12h', label: 'Last 12 hours', earliest: '-12h', latest: 'now' },
    { id: '24h', label: 'Last 24 hours', earliest: '-24h', latest: 'now' },
    { id: '2d',  label: 'Last 2 days',   earliest: '-2d',  latest: 'now' },
    { id: '3d',  label: 'Last 3 days',   earliest: '-3d',  latest: 'now' },
    { id: '5d',  label: 'Last 5 days',   earliest: '-5d',  latest: 'now' },
    { id: '7d',  label: 'Last 7 days',   earliest: '-7d',  latest: 'now' },
    { id: '14d', label: 'Last 14 days',  earliest: '-14d', latest: 'now' },
    { id: '30d', label: 'Last 30 days',  earliest: '-30d', latest: 'now' },
];

const DEFAULT_TIME_RANGE_ID = '24h';
const SESSION_KEY_TIME_RANGE = 'logserv.aiAssistant.promptTimeRange';
const SESSION_KEY_ACTIVE_PACK = 'logserv.aiAssistant.promptActivePack';
/** Synthetic pack id (build 158 / session 027 task 5) — does NOT exist as a
 *  pack in the intent map. Drives a virtual tab whose contents are filtered
 *  from the global prompt list by the dashboard the user currently has open
 *  (via `findDashboardByPath(useLocation().pathname)`), based on each prompt's
 *  `dashboard` field. The tab hides when the active dashboard has zero
 *  matching prompts. */
const DASHBOARD_FOCUSED: 'dashboard_focused' = 'dashboard_focused';
type ActivePack = PromptPack | typeof DASHBOARD_FOCUSED;
const VALID_PACKS: ReadonlyArray<PromptPack> = ['sap_basis', 'security', 'operations'];
const VALID_ACTIVE_PACKS: ReadonlyArray<ActivePack> = [DASHBOARD_FOCUSED, ...VALID_PACKS];
const DEFAULT_PACK: ActivePack = 'sap_basis';

const readTimeRangeFromSession = (): string => {
    try {
        const v = window.sessionStorage.getItem(SESSION_KEY_TIME_RANGE);
        if (v && TIME_RANGE_OPTIONS.some((o) => o.id === v)) return v;
    } catch (_e) { /* ignore */ }
    return DEFAULT_TIME_RANGE_ID;
};

const writeTimeRangeToSession = (id: string): void => {
    try { window.sessionStorage.setItem(SESSION_KEY_TIME_RANGE, id); } catch (_e) { /* ignore */ }
};

/**
 * Active-pack persistence. Read on modal open; written ONLY when the
 * user actually picks a prompt from the tab (per build-140 design —
 * "remember the tab IF I selected a prompt from it"). Casual tab-
 * browsing without a selection doesn't persist.
 *
 * Build 158 / session 027 task 5: the persistable set now also includes
 * the synthetic `dashboard_focused` value. If the user last selected a
 * prompt from the Dashboard Focused tab, the next modal open re-opens
 * to the same tab — but if the tab would be empty for the current
 * dashboard, the resolver below silently falls back to the previous
 * default. So "remembered tab" stays a soft preference, not a UX trap.
 */
const readActivePackFromSession = (): ActivePack => {
    try {
        const v = window.sessionStorage.getItem(SESSION_KEY_ACTIVE_PACK);
        if (v && VALID_ACTIVE_PACKS.includes(v as ActivePack)) return v as ActivePack;
    } catch (_e) { /* ignore */ }
    return DEFAULT_PACK;
};

const writeActivePackToSession = (pack: ActivePack): void => {
    try { window.sessionStorage.setItem(SESSION_KEY_ACTIVE_PACK, pack); } catch (_e) { /* ignore */ }
};

export const findTimeRangeById = (id: string): TimeRangeOption =>
    TIME_RANGE_OPTIONS.find((o) => o.id === id) ?? TIME_RANGE_OPTIONS[3];

/**
 * PromptBrowser — drawer/modal that lists predefined prompts grouped
 * into 3 packs (SAP Basis / Security / Operations). Clicking a prompt
 * fires `onPromptSelected` with the prompt's full descriptor; the
 * orchestrator uses that to call `runCannedPrompt`.
 *
 * Per design §7.4: clicking a prompt EXECUTES IMMEDIATELY (no extra
 * Send press). Bypasses the AI vendor entirely; runs the pre-baked
 * SPL via MCP. SPL is shown inline in the chat for transparency.
 */

export type PromptPack = 'sap_basis' | 'security' | 'operations';

export interface PromptDescriptor {
    id: string;
    pack: PromptPack;
    label: string;
    description: string;
    savedSearch: string;
    spl: string;
    renderHint: 'table' | 'timechart' | 'kpi' | 'pie';
    /** Optional related-dashboard slug(s) — single string or array. Powers
     *  the filter logic for the Dashboard Focused tab (build 158): a
     *  prompt is shown in the Dashboard Focused tab IFF its `dashboard`
     *  field includes the slug of the dashboard the user currently has
     *  open. Slugs match `routes/dashboardRegistry.ts`. */
    dashboard?: string | string[];
    /** Optional companion chart hint for table-primary entries — read
     *  from the intent map. Threaded through to the tool_result
     *  message so ToolResultPanel can render a chart above the table. */
    chartHint?: 'timechart' | 'kpi' | 'pie';
    /** Optional explicit palette for the chart (timechart / pie /
     *  table+chartHint variants). Mirrors the dashboard convention of
     *  passing `palette=` per chart. When omitted, ToolResultPanel
     *  auto-detects from the value-field shape. Build 139. */
    chartPalette?: ChartPalette;
    /** Optional 1-2 sentence interpretation hint — what the result
     *  means, what patterns to look for. Rendered as a `'guidance'`
     *  chat message after the tool_result lands. Build 140. */
    interpretation?: string;
    /** Optional ordered list of next-step suggestions. Each step is
     *  either a plain string (no link) OR a link object that opens
     *  Splunk's search app in a new tab with a deep-dive SPL query.
     *  Build 141 — link objects can carry either a `savedSearch` name
     *  (resolved at runtime to that prompt's SPL) or a custom `spl`
     *  string for ad-hoc deep dives. Time range from the dispatch is
     *  applied to the link URL. */
    nextSteps?: Array<NextStepEntry>;
}

/** A nextStep can be plain prose (no action) OR a link entry that opens
 *  Splunk's search app with a deep-dive SPL query in a new tab. Build 141. */
export type NextStepEntry = string | NextStepLink;

export interface NextStepLink {
    /** Display text — rendered as the link label. */
    text: string;
    /** When set, look up that prompt's SPL via the intent map and use
     *  it as the link target. Avoids duplicating SPL strings. */
    savedSearch?: string;
    /** When set, use this raw SPL directly. For custom ad-hoc deep
     *  dives that aren't a canned prompt. */
    spl?: string;
}

interface IntentMapShape {
    version: string;
    description?: string;
    packs: Record<PromptPack, { label: string; description: string }>;
    prompts: PromptDescriptor[];
}

const typedIntentMap = intentMap as unknown as IntentMapShape;

interface PromptBrowserProps {
    onPromptSelected: (prompt: PromptDescriptor, timeRange: TimeRangeOption) => void;
    onClose?: () => void;
}

const Overlay = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
`;

const Drawer = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.medium};
    padding: ${logservTheme.spacing.lg};
    width: 760px;
    max-height: 80vh;
    overflow-y: auto;
    color: ${logservTheme.colors.textActive};
`;

const Header = styled.div`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${logservTheme.spacing.md};
    margin-bottom: ${logservTheme.spacing.lg};
`;

const TimeRangeRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.lg};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
`;

const TimeRangeSelect = styled.select`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 4px 8px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const TimeRangeHint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const Title = styled.h3`
    margin: 0;
    font-size: ${logservTheme.fontSize.xlarge};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const CloseButton = styled.button`
    background: transparent;
    border: 0;
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.large};
    padding: 4px 8px;
    font-family: inherit;

    &:hover { color: ${logservTheme.colors.textActive}; }
`;

const Tabs = styled.div`
    display: flex;
    gap: 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    margin-bottom: ${logservTheme.spacing.lg};
`;

const Tab = styled.button<{ $active: boolean }>`
    background: transparent;
    border: 0;
    border-bottom: 2px solid ${(p) => (p.$active ? logservTheme.colors.cyanAccent : 'transparent')};
    color: ${(p) => (p.$active ? logservTheme.colors.textActive : logservTheme.colors.textMuted)};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.lg};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;

    &:hover { color: ${logservTheme.colors.textActive}; }
`;

const PromptList = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.xs};
`;

const PromptCard = styled.button`
    background: ${logservTheme.colors.tableHeaderBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-left: 3px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    padding: ${logservTheme.spacing.md};
    cursor: pointer;
    text-align: left;
    color: ${logservTheme.colors.textActive};
    font-family: inherit;
    width: 100%;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-left-color: ${logservTheme.colors.cyanLight};
    }
`;

const PromptLabelRow = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.xs};
`;

const PromptLabel = styled.div`
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const PromptDescription = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    line-height: 1.4;
`;

/* Pack-origin chip rendered next to the prompt label inside the
   Dashboard Focused tab. Tells the user which existing pack the prompt
   also lives in so they can find it again via the SAP Basis / Security /
   Operations tabs. Build 158 / session 027 task 5. */
const PackChip = styled.span<{ $pack: PromptPack }>`
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: ${logservTheme.fontWeight.semibold};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;

    ${(p) => {
        switch (p.$pack) {
            case 'sap_basis':
                return `background: rgba(8, 119, 166, 0.18); color: ${logservTheme.colors.cyanLight}; border: 1px solid ${logservTheme.colors.cyanAccent};`;
            case 'security':
                return `background: rgba(220, 78, 65, 0.18); color: #ff8a7e; border: 1px solid ${logservTheme.colors.red};`;
            case 'operations':
                return `background: rgba(241, 129, 63, 0.18); color: #f4a535; border: 1px solid ${logservTheme.colors.orange};`;
            default:
                return `background: ${logservTheme.colors.tableHeaderBackground}; color: ${logservTheme.colors.textMuted};`;
        }
    }}
`;

/* Empty-state line shown inside the Dashboard Focused tab when the
   filtering produces zero results — though per design, the tab itself
   hides when the count is zero, so this only renders if the filter
   logic ever shifts to "show tab regardless". Defensive default. */
const EmptyHint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    padding: ${logservTheme.spacing.lg};
    text-align: center;
    border: 1px dashed ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
`;

const PromptBrowser: React.FC<PromptBrowserProps> = ({ onPromptSelected, onClose }) => {
    const [activePack, setActivePack] = useState<ActivePack>(readActivePackFromSession);
    const [timeRangeId, setTimeRangeId] = useState<string>(readTimeRangeFromSession);

    /* Build 158 / session 027 task 5: derive the current dashboard's slug
     * from the React Router location, then filter prompts whose `dashboard`
     * field includes that slug. Updates LIVE — if the user navigates
     * between dashboards while the modal is open, the Dashboard Focused
     * tab content recomputes (useLocation is reactive in v6 + the
     * useMemo's deps include location.pathname). */
    const location = useLocation();
    const currentDashboard = useMemo(
        () => findDashboardByPath(location.pathname),
        [location.pathname],
    );
    const dashboardFocusedPrompts = useMemo(() => {
        if (!currentDashboard) return [];
        const slug = currentDashboard.slug;
        return typedIntentMap.prompts.filter((p) => {
            const dash = p.dashboard;
            if (!dash) return false;
            const slugs = Array.isArray(dash) ? dash : [dash];
            return slugs.includes(slug);
        });
    }, [currentDashboard]);
    const showDashboardFocusedTab = dashboardFocusedPrompts.length > 0;

    /* If the persisted activePack from the prior session was 'dashboard_focused'
     * but the current dashboard has zero matches, the tab will be hidden — so
     * fall back gracefully. Otherwise the user lands on a closed/missing tab. */
    const effectiveActivePack: ActivePack =
        activePack === DASHBOARD_FOCUSED && !showDashboardFocusedTab ? DEFAULT_PACK : activePack;

    const visiblePrompts =
        effectiveActivePack === DASHBOARD_FOCUSED
            ? dashboardFocusedPrompts
            : typedIntentMap.prompts.filter((p) => p.pack === effectiveActivePack);

    /* Tab order: Dashboard Focused (when present) | SAP Basis | Security | Operations */
    const tabsToRender: ActivePack[] = showDashboardFocusedTab
        ? [DASHBOARD_FOCUSED, ...VALID_PACKS]
        : [...VALID_PACKS];

    const tabLabel = (pk: ActivePack): string => {
        if (pk === DASHBOARD_FOCUSED) {
            return currentDashboard
                ? `Dashboard Focused (${dashboardFocusedPrompts.length})`
                : 'Dashboard Focused';
        }
        return typedIntentMap.packs[pk]?.label ?? pk;
    };

    const handleTimeRangeChange = (id: string): void => {
        setTimeRangeId(id);
        writeTimeRangeToSession(id);
    };

    return (
        <Overlay onClick={onClose}>
            <Drawer onClick={(e) => e.stopPropagation()}>
                <Header>
                    <Title>Browse predefined prompts</Title>
                    <CloseButton type="button" onClick={onClose} aria-label="Close">
                        ✕
                    </CloseButton>
                </Header>
                <TimeRangeRow>
                    <label htmlFor="prompt-time-range">Time range:</label>
                    <TimeRangeSelect
                        id="prompt-time-range"
                        value={timeRangeId}
                        onChange={(e) => handleTimeRangeChange(e.target.value)}
                    >
                        {TIME_RANGE_OPTIONS.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                    </TimeRangeSelect>
                    <TimeRangeHint>
                        Applied to every prompt below — overrides any earliest/latest the
                        saved search has hardcoded.
                    </TimeRangeHint>
                </TimeRangeRow>
                <Tabs>
                    {tabsToRender.map((pk) => (
                        <Tab
                            key={pk}
                            $active={effectiveActivePack === pk}
                            type="button"
                            onClick={() => setActivePack(pk)}
                            title={
                                pk === DASHBOARD_FOCUSED && currentDashboard
                                    ? `Prompts relevant to ${currentDashboard.name}`
                                    : undefined
                            }
                        >
                            {tabLabel(pk)}
                        </Tab>
                    ))}
                </Tabs>
                <PromptList>
                    {visiblePrompts.length === 0 ? (
                        <EmptyHint>No prompts available in this tab.</EmptyHint>
                    ) : (
                        visiblePrompts.map((p) => (
                            <PromptCard
                                key={p.id}
                                type="button"
                                onClick={() => {
                                    /* Persist the active pack on selection so
                                     * the next "Browse Prompts" open lands on
                                     * the same tab. Build 140 — only writes
                                     * on a real selection (not on casual
                                     * tab-flipping). Build 158 extends this
                                     * to also persist the synthetic
                                     * dashboard_focused value. */
                                    writeActivePackToSession(effectiveActivePack);
                                    onPromptSelected(p, findTimeRangeById(timeRangeId));
                                    onClose && onClose();
                                }}
                            >
                                <PromptLabelRow>
                                    <PromptLabel>{p.label}</PromptLabel>
                                    {effectiveActivePack === DASHBOARD_FOCUSED && (
                                        <PackChip $pack={p.pack}>
                                            {typedIntentMap.packs[p.pack]?.label ?? p.pack}
                                        </PackChip>
                                    )}
                                </PromptLabelRow>
                                <PromptDescription>{p.description}</PromptDescription>
                            </PromptCard>
                        ))
                    )}
                </PromptList>
            </Drawer>
        </Overlay>
    );
};

export default PromptBrowser;
