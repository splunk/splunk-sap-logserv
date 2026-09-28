import React from 'react';
import styled, { keyframes } from 'styled-components';
import TimeRange from '@splunk/react-time-range';
import SplunkwebConnector from '@splunk/react-time-range/SplunkwebConnector';
import { useTimeRange } from '../state/TimeRangeProvider';
import { useThemeMode } from '../state/ThemeModeProvider';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';
import { logservTheme } from '../styles/logservTheme';
import { APP_VERSION, APP_BUILD } from '../buildFlags';
import ActionsDropdown, { HEADER_BUTTON_HEIGHT_PX } from './ActionsDropdown';

/**
 * The app header — TWO ROWS, matching the Magnetic preview's shell
 * (`jan_magnetic/logserv-magnetic-preview.html`, Artifact v15).
 *
 *   row 1 — identity and status: brand lockup, version pills, mode toggle.
 *   row 2 — controls: the time range, then Actions / Refresh / AI Assistant.
 *
 * Phase 7 build 339 shipped this as a SINGLE 48px row. That was a gap rather
 * than a decision: plan §16.1 lists what the header keeps (time range,
 * Actions, mode toggle, the two version pills) but never describes its
 * structure, and the contents list was read without the preview's layout.
 * Build 342 restores the two-row split the preview was reviewed with.
 *
 * WHAT DELIBERATELY DIFFERS FROM THE PREVIEW, and why — so a future reader
 * does not "fix" these back:
 *
 *  - No `Ingest healthy` pill (Q10). The App performs no such health check.
 *    A hardcoded "healthy" would be a false claim on screen.
 *  - `App <version>`, not `Data TA <version>` (Q10). These are the App's own
 *    compile-time constants from `buildFlags.ts` — no REST call, and no
 *    "Data TA not installed" case to handle. They render `—` when empty,
 *    matching AboutModal, so a build that forgot to inject them degrades to
 *    a dash rather than an empty pill.
 *  - No palette picker. The preview's `Workbench scaffold ▾` control switches
 *    between three Harbor palettes for comparison; it is a preview device,
 *    not a product feature.
 *  - The accent here is `cyanAccent`, the app's general accent, while the
 *    RAIL's active marker stays `navAccent` (the OneCD teal). Q8 kept
 *    navAccent specifically for nav-active; the time-range pills are not
 *    navigation.
 *
 * THE TIME RANGE (option B, user-chosen 2026-09-21). Preset pills as in the
 * preview — four since build 345 removed `Last 60m` (see PRESETS) — plus
 * Splunk's own `<TimeRange>` control, under its own label, as the custom-range
 * affordance — clicking it opens Splunk's full dialog (Presets, Relative,
 * Real-time, Date Range, Date & Time Range, Advanced).
 *
 * It is Splunk's real control rather than a pill that opens the dialog
 * programmatically, because it CANNOT be opened programmatically: the
 * dropdown's `open` / `onRequestOpen` belong to the inner
 * `@splunk/react-ui` Dropdown and are not props on `TimeRange`. Driving it
 * would mean reaching into another vendor's internals. The wrapper styles it
 * to sit in the pill row by targeting its rendered `button` element — a
 * structural selector, not a hashed class — and it also serves as the
 * current-value display whenever the range matches no preset.
 */

/* Preset tokens are Splunk's own snap syntax so they round-trip cleanly
 * through the dialog: pick "Last 7d" here, open the dialog, and it shows the
 * matching preset rather than an unrecognised custom range. `Last 30d`
 * deliberately equals TimeRangeProvider's DEFAULT_RANGE, so a fresh page
 * opens with that pill already active rather than showing "Custom". */
interface Preset {
    label: string;
    earliest: string;
    latest: string;
}

const PRESETS: readonly Preset[] = [
    /* `Last 60m` was offered in build 342 and REMOVED in 345 at the user's
     * request. Worth recording that it was removed as a product choice, not
     * because it could not work: `shouldUseRawSource` routes any window under
     * HYBRID_RAW_MAX_SPAN_SEC (90 min) to the raw arm, and
     * `hybridRouting.consistency-test.ts` pins `-60m@m → RAW` explicitly, so
     * the hourly-rollup floor never applied to it. Sub-90-minute windows are
     * still reachable through the Custom control and still route correctly. */
    { label: 'Last 24h', earliest: '-24h@h', latest: 'now' },
    { label: 'Last 7d', earliest: '-7d@h', latest: 'now' },
    { label: 'Last 30d', earliest: '-30d@d', latest: 'now' },
    { label: 'Last 90d', earliest: '-90d@d', latest: 'now' },
];

const Header = styled.header`
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    background: ${logservTheme.colors.navBackground};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const TopRow = styled.div`
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${logservTheme.spacing.lg};
    padding: 0 20px;
`;

const Brand = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.md};
    min-width: 0;
`;

const BrandMark = styled.svg`
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    color: ${logservTheme.colors.cyanAccent};
    display: block;
`;

const BrandTitle = styled.span`
    font-family: ${logservTheme.font.heading};
    font-size: 15px;
    font-weight: ${logservTheme.fontWeight.bold};
    color: ${logservTheme.colors.textActive};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const Meta = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    justify-content: flex-end;
`;

const Pill = styled.span`
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: ${logservTheme.fontWeight.normal};
    color: ${logservTheme.colors.textDefault};
    background: ${logservTheme.colors.hoverBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    white-space: nowrap;

    /* First to go when the header runs out of room — the same two values are
       one click away in About, so losing them costs nothing an operator
       needs. */
    @media (max-width: 900px) {
        display: none;
    }
`;

const IconButton = styled.button`
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: ${logservTheme.radius.medium};
    background: transparent;
    color: ${logservTheme.colors.textDefault};
    font: inherit;
    cursor: pointer;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.textActive};
        border-color: ${logservTheme.colors.panelBorder};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }

    svg {
        display: block;
    }
`;

/* --- row 2 ---------------------------------------------------------- */

const SubRow = styled.div`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 20px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    flex-wrap: wrap;
`;

const RangeLabel = styled.span`
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: ${logservTheme.colors.textDefault};
    white-space: nowrap;

    b {
        color: ${logservTheme.colors.textActive};
        font-weight: ${logservTheme.fontWeight.semibold};
    }
`;

const Dot = styled.span`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${logservTheme.colors.cyanAccent};
    flex: 0 0 auto;
`;

const Pills = styled.div`
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
`;

const RangePill = styled.button<{ $active: boolean }>`
    box-sizing: border-box;
    padding: 5px 13px;
    border-radius: 999px;
    font-size: 12px;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    background: ${(p) => (p.$active ? logservTheme.colors.cyanAccent : 'transparent')};
    border: 1px solid
        ${(p) =>
            p.$active ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak};
    color: ${(p) => (p.$active ? '#ffffff' : logservTheme.colors.textDefault)};
    font-weight: ${(p) =>
        p.$active ? logservTheme.fontWeight.semibold : logservTheme.fontWeight.normal};

    &:hover {
        color: ${(p) => (p.$active ? '#ffffff' : logservTheme.colors.textActive)};
        border-color: ${logservTheme.colors.panelBorder};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: 1px;
    }
`;

/* Splunk's own TimeRange control, restyled to sit among the pills. The
 * descendant `button` selector is structural rather than a hashed class, so
 * it survives a vendor minor; if a future version changes the element, the
 * control still works and merely looks like Splunk's default. */
const CustomRange = styled.div`
    display: inline-flex;
    align-items: center;

    button {
        box-sizing: border-box;
        border-radius: 999px !important;
        font-size: 12px !important;
        min-height: 0 !important;
        padding: 4px 13px !important;
        white-space: nowrap;
    }
`;

const Spacer = styled.div`
    flex: 1 1 auto;
`;

const BarButton = styled.button<{ $accent?: boolean }>`
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    /* The same height as the Actions button between the time range and
     * these (session 138) - their natural height, now pinned for both. */
    height: ${HEADER_BUTTON_HEIGHT_PX}px;
    padding: 6px 13px;
    border-radius: ${logservTheme.radius.medium};
    font-size: 12px;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
    background: ${(p) => (p.$accent ? logservTheme.colors.hoverBackground : 'transparent')};
    border: 1px solid
        ${(p) => (p.$accent ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak)};
    color: ${(p) => (p.$accent ? logservTheme.colors.cyanLight : logservTheme.colors.textDefault)};
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover {
        color: ${(p) => (p.$accent ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.panelBorder};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }

    svg {
        width: 15px;
        height: 15px;
        display: block;
    }
`;

/* --- icons ---------------------------------------------------------- */

const LogServMark: React.FC = () => (
    <BrandMark
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <path d="M8.2 8.4v7.2h3.1" />
        <path d="M16.4 9.1a2 2 0 0 0-3.3 1.4c0 1.9 3.4 1.1 3.4 3a2 2 0 0 1-3.3 1.2" />
    </BrandMark>
);

const SunIcon: React.FC = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </svg>
);

const MoonIcon: React.FC = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z" />
    </svg>
);

const spin = keyframes`
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
`;
const RefreshIconSvg = styled.svg<{ $spinning: boolean }>`
    animation: ${(p) => (p.$spinning ? spin : 'none')} 0.6s linear;
`;
const RefreshIcon: React.FC<{ spinning: boolean }> = ({ spinning }) => (
    <RefreshIconSvg
        $spinning={spinning}
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

const WandIcon: React.FC = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 19 19 5" />
        <path d="M14.5 5.5 18.5 9.5" />
        <path d="M6 3.5v3M4.5 5h3M17 16.5v3M15.5 18h3" />
    </svg>
);

interface NavigationBarProps {
    /** When provided, renders the AI Assistant toggle. Omit to hide it
     *  (e.g. when the feature flag is off). */
    onToggleAIAssistant?: () => void;
    /** Highlights the AI Assistant button when its panel is open. */
    aiAssistantOpen?: boolean;
}

const NavigationBar: React.FC<NavigationBarProps> = ({
    onToggleAIAssistant,
    aiAssistantOpen = false,
}) => {
    const { timeRange, setTimeRange } = useTimeRange();
    const { mode, setMode } = useThemeMode();
    const { triggerGlobalRefresh } = useGlobalRefresh();
    const [refreshSpinning, setRefreshSpinning] = React.useState<boolean>(false);

    const handleRefresh = React.useCallback((): void => {
        triggerGlobalRefresh();
        // Brief spin as click feedback; the icon resets after the animation.
        setRefreshSpinning(true);
        window.setTimeout(() => setRefreshSpinning(false), 600);
    }, [triggerGlobalRefresh]);

    const activePreset = React.useMemo(
        () =>
            PRESETS.find(
                (p) => p.earliest === timeRange.earliest && p.latest === timeRange.latest,
            ),
        [timeRange.earliest, timeRange.latest],
    );

    return (
        /* data-logserv-header: the AI Assistant's SidePanel measures this
         * element's bottom edge to sit flush below the header (session 138). */
        <Header data-logserv-header="true">
            <TopRow>
                <Brand>
                    <LogServMark />
                    <BrandTitle>Splunk for SAP LogServ</BrandTitle>
                </Brand>

                <Meta>
                    <Pill title="Installed app version">App {APP_VERSION || '—'}</Pill>
                    <Pill title="Installed app build number">build {APP_BUILD || '—'}</Pill>
                    <IconButton
                        type="button"
                        onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
                        aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                        title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    >
                        {mode === 'dark' ? <SunIcon /> : <MoonIcon />}
                    </IconButton>
                </Meta>
            </TopRow>

            <SubRow>
                <RangeLabel>
                    <Dot aria-hidden />
                    Time range <b>{activePreset ? activePreset.label : 'Custom'}</b>
                </RangeLabel>

                <Pills>
                    {PRESETS.map((p) => (
                        <RangePill
                            key={p.label}
                            type="button"
                            $active={activePreset === p}
                            aria-pressed={activePreset === p}
                            onClick={() => setTimeRange({ earliest: p.earliest, latest: p.latest })}
                        >
                            {p.label}
                        </RangePill>
                    ))}

                    {/* SplunkwebConnector injects parseEarliest/parseLatest +
                        onRequestParseEarliest/Latest + the preset list via
                        Splunk's splunkweb context. Without it TimeRange has no
                        way to validate input and its Apply button stays
                        disabled permanently. */}
                    <CustomRange>
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
                                        setTimeRange({
                                            earliest: data.earliest,
                                            latest: data.latest,
                                        });
                                    }
                                }}
                            />
                        </SplunkwebConnector>
                    </CustomRange>
                </Pills>

                <Spacer />

                <ActionsDropdown />

                <BarButton
                    type="button"
                    onClick={handleRefresh}
                    aria-label="Refresh dashboard"
                    title="Refresh — re-run all panels for the selected time range"
                >
                    <RefreshIcon spinning={refreshSpinning} />
                    Refresh
                </BarButton>

                {onToggleAIAssistant && (
                    <BarButton
                        type="button"
                        $accent
                        onClick={onToggleAIAssistant}
                        aria-pressed={aiAssistantOpen}
                        aria-label={aiAssistantOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
                    >
                        <WandIcon />
                        AI Assistant
                    </BarButton>
                )}
            </SubRow>
        </Header>
    );
};

export default NavigationBar;
