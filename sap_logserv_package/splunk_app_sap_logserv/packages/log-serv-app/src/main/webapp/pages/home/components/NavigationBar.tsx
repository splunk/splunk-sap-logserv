import React from 'react';
import { NavLink } from 'react-router-dom';
import styled, { keyframes } from 'styled-components';
import TimeRange from '@splunk/react-time-range';
import SplunkwebConnector from '@splunk/react-time-range/SplunkwebConnector';
import { useTimeRange } from '../state/TimeRangeProvider';
import { dashboardsByCategory } from '../routes/dashboardRegistry';
import { useIsAdmin } from '../hooks/useIsAdmin';
import { useThemeMode } from '../state/ThemeModeProvider';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';
import { logservTheme } from '../styles/logservTheme';
import NavCategoryDropdown from './NavCategoryDropdown';
import ActionsDropdown from './ActionsDropdown';

const Bar = styled.div`
    display: flex;
    align-items: stretch;
    gap: ${logservTheme.spacing.xs};
    padding: 0 ${logservTheme.spacing.lg};
    background: ${logservTheme.colors.navBackground};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    min-height: 48px;
`;

const HomeLink = styled(NavLink)`
    background: transparent;
    color: ${logservTheme.colors.textActive};
    text-decoration: none;
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    border-bottom: 2px solid transparent;
    display: flex;
    align-items: center;
    transition: background-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }

    &.active {
        background: ${logservTheme.colors.hoverBackground};
        border-bottom-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const Spacer = styled.div`
    flex: 1;
`;

/* Admin-only settings link in the right-hand cluster of the nav bar.
 * Visible only when `useIsAdmin().isAdmin === true`. The Splunk REST
 * endpoints powering the settings page are also gated server-side
 * (require the edit_storage_passwords capability), so this client-side
 * gate is a UX nicety, not the security boundary. */
const SettingsLink = styled(NavLink)`
    background: transparent;
    color: ${logservTheme.colors.textActive};
    text-decoration: none;
    align-self: center;
    /* Padding + border match AIAssistantButton so the right-edge nav cluster
     * (Settings · Actions · AI Assistant) renders three buttons with
     * identical heights and visible outlines. Build 127 / session 024. */
    padding: 6px 12px;
    margin-right: ${logservTheme.spacing.sm};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &.active {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanLight};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const TimeRangeWrapper = styled.div`
    display: flex;
    align-items: center;
    padding-left: ${logservTheme.spacing.md};
`;

/* Light/dark mode toggle — mirrors Magnetic's header ModeSelector (sun /
 * moon-stars icon button). Chrome matches SettingsLink / AIAssistantButton
 * so the right-edge cluster stays visually uniform. Phase 1a / build 247. */
const ModeToggleButton = styled.button`
    background: transparent;
    color: ${logservTheme.colors.textActive};
    align-self: center;
    padding: 6px 10px;
    margin-right: ${logservTheme.spacing.sm};
    cursor: pointer;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    display: inline-flex;
    align-items: center;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }

    svg {
        display: block;
    }
`;

const SunIcon: React.FC = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </svg>
);

const MoonIcon: React.FC = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z" />
    </svg>
);

/* Manual refresh button (session 088) — re-runs every panel on the current view
 * with the selected time range (bumps the GlobalRefreshProvider nonce, which
 * useSearch reads). Sits at the far RIGHT of the nav bar, after the time-range
 * picker. Chrome matches ModeToggleButton so the right-edge icon cluster stays
 * uniform; margin-LEFT (not right) since it's the last element. */
const spin = keyframes`
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
`;
const RefreshButton = styled.button`
    background: transparent;
    color: ${logservTheme.colors.textActive};
    align-self: center;
    padding: 6px 10px;
    margin-left: ${logservTheme.spacing.sm};
    cursor: pointer;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    display: inline-flex;
    align-items: center;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }

    svg {
        display: block;
    }
`;
const RefreshIconSvg = styled.svg<{ $spinning: boolean }>`
    animation: ${(p) => (p.$spinning ? spin : 'none')} 0.6s linear;
`;
const RefreshIcon: React.FC<{ spinning: boolean }> = ({ spinning }) => (
    <RefreshIconSvg
        $spinning={spinning}
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
    </RefreshIconSvg>
);

const AIAssistantButton = styled.button<{ $active: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${(p) => (p.$active ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
    border: 1px solid ${(p) => (p.$active ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 12px;
    margin-right: ${logservTheme.spacing.sm};
    align-self: center;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

interface NavigationBarProps {
    /** When provided, renders an "AI Assistant" toggle button before the time
     *  range picker. Omit to hide the button (e.g., when the feature flag is off). */
    onToggleAIAssistant?: () => void;
    /** Highlights the AI Assistant button when its panel is open. */
    aiAssistantOpen?: boolean;
}

const NavigationBar: React.FC<NavigationBarProps> = ({ onToggleAIAssistant, aiAssistantOpen = false }) => {
    const { timeRange, setTimeRange } = useTimeRange();
    const { isAdmin } = useIsAdmin();
    const { mode, setMode } = useThemeMode();
    const { triggerGlobalRefresh } = useGlobalRefresh();
    const [refreshSpinning, setRefreshSpinning] = React.useState<boolean>(false);
    const handleRefresh = React.useCallback((): void => {
        triggerGlobalRefresh();
        // Brief spin as click feedback; the icon resets after the animation.
        setRefreshSpinning(true);
        window.setTimeout(() => setRefreshSpinning(false), 600);
    }, [triggerGlobalRefresh]);

    return (
        <Bar>
            <HomeLink to="/" end>
                Environment Health
            </HomeLink>

            {/* Topology is a single-dashboard top-level link (not a dropdown) so
              * the Topology view is one click away. If we add more topology
              * views later, swap back to a NavCategoryDropdown. */}
            <HomeLink to="/topology/integration-topology">
                Topology
            </HomeLink>

            <NavCategoryDropdown
                label="Applications"
                items={dashboardsByCategory.applications}
                matchPathPrefix="/applications/"
            />
            <NavCategoryDropdown
                label="Integration"
                items={dashboardsByCategory.integration}
                matchPathPrefix="/integration/"
            />
            <NavCategoryDropdown
                label="Security"
                items={dashboardsByCategory.security}
                matchPathPrefix="/security/"
            />
            <NavCategoryDropdown
                label="Platform"
                items={dashboardsByCategory.platform}
                matchPathPrefix="/platform/"
            />

            <Spacer />

            <ModeToggleButton
                type="button"
                onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
                aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
                {mode === 'dark' ? <SunIcon /> : <MoonIcon />}
            </ModeToggleButton>

            {isAdmin && (
                <SettingsLink to="/settings" aria-label="Application Settings">
                    <span aria-hidden>⚙</span>
                    Settings
                </SettingsLink>
            )}

            <ActionsDropdown />

            {onToggleAIAssistant && (
                <AIAssistantButton
                    type="button"
                    onClick={onToggleAIAssistant}
                    $active={aiAssistantOpen}
                    aria-pressed={aiAssistantOpen}
                    aria-label={aiAssistantOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
                >
                    <span aria-hidden>✦</span>
                    AI Assistant
                </AIAssistantButton>
            )}

            <TimeRangeWrapper>
                {/* SplunkwebConnector injects parseEarliest/parseLatest +
                 * onRequestParseEarliest/Latest + presets via Splunk's
                 * splunkweb context. Without it, TimeRange has no way to
                 * validate user input and the Apply button stays disabled
                 * permanently. (See @splunk/react-time-range docs:
                 * "this function is required when not using the
                 * SplunkwebConnector".) */}
                <SplunkwebConnector>
                    <TimeRange
                        earliest={timeRange.earliest}
                        latest={timeRange.latest}
                        onChange={(_e, data) => {
                            if (
                                data &&
                                typeof data.earliest === 'string' &&
                                typeof data.latest === 'string'
                            ) {
                                setTimeRange({ earliest: data.earliest, latest: data.latest });
                            }
                        }}
                    />
                </SplunkwebConnector>
            </TimeRangeWrapper>

            <RefreshButton
                type="button"
                onClick={handleRefresh}
                aria-label="Refresh dashboard"
                title="Refresh — re-run all panels for the selected time range"
            >
                <RefreshIcon spinning={refreshSpinning} />
            </RefreshButton>
        </Bar>
    );
};

export default NavigationBar;
