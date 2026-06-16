import React, { ReactNode, useMemo, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { PanelMeta, PanelMetaContext, PanelActions } from './PanelMeta';

/**
 * FramedPanel — the v0.0.4.2 "framed dark cards" container.
 *
 * Cyan-outlined dark fill with rounded corners, optional title and
 * inline-right action area. Foundation primitive for every dashboard panel.
 */

interface PanelRootProps {
    $compact?: boolean;
    /** When true, the panel is interactive — cursor: pointer + a hover
     *  state that brightens the border + lifts with a subtle shadow.
     *  Build 157 / session 027 task 4 — wires KPI / chart drilldowns. */
    $clickable?: boolean;
}

const Root = styled.section<PanelRootProps>`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    padding: ${(p) => (p.$compact ? logservTheme.spacing.md : logservTheme.spacing.lg)};
    color: ${logservTheme.colors.textActive};
    overflow: hidden;

    ${(p) =>
        p.$clickable
            ? `
        cursor: pointer;
        transition: border-color 120ms ease-out, box-shadow 120ms ease-out;

        &:hover {
            border-color: ${logservTheme.colors.cyanLight};
            box-shadow: 0 0 0 1px ${logservTheme.colors.cyanAccent};
        }

        &:focus-visible {
            outline: 2px solid ${logservTheme.colors.cyanLight};
            outline-offset: 2px;
        }
    `
            : ''}
`;

const Header = styled.header`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.md};
`;

const Title = styled.h2`
    margin: 0;
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Subtitle = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const Body = styled.div`
    color: ${logservTheme.colors.textDefault};
`;

/** Right-side header cluster: any caller-supplied `actions` plus the build-234
 *  PanelActions toolbar, vertically centered (icons, not text baselines). */
const HeaderRight = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    align-self: center;
`;

interface FramedPanelProps {
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    /** Build 234 — the panel's search result (from useSearch). When provided,
     *  FramedPanel renders the Open-in-Search / Download / Inspect / Refresh
     *  toolbar in the header. Tables pass this explicitly; charts report it
     *  automatically via PanelMetaContext (see usePanelMetaReporter), so chart
     *  panels need no prop. */
    search?: PanelMeta;
    /** Opt out of the action toolbar for a specific panel (e.g. non-data
     *  panels, or where the chrome would be redundant). */
    noToolbar?: boolean;
    compact?: boolean;
    children?: ReactNode;
    className?: string;
    /** Click handler — when set, the whole panel becomes interactive
     *  (cursor: pointer + hover state) and clicking anywhere in the panel
     *  fires the handler. Used for drilldowns. Inner clickable elements
     *  (e.g., chart points, table cells) still capture their own clicks
     *  before the panel-level handler fires; the panel's handler only
     *  catches clicks on the chrome and on chart background area.
     *  Build 157 / session 027 task 4. */
    onClick?: () => void;
    /** Tooltip / aria-label for the click affordance. Optional but
     *  strongly recommended when `onClick` is set. */
    clickTitle?: string;
}

const FramedPanel: React.FC<FramedPanelProps> = ({
    title,
    subtitle,
    actions,
    search,
    noToolbar,
    compact,
    children,
    className,
    onClick,
    clickTitle,
}) => {
    // Build 234 — capture search meta reported by an inner chart (charts run
    // their own useSearch); tables pass `search` explicitly. Either drives the
    // PanelActions toolbar.
    const [captured, setCaptured] = useState<PanelMeta | null>(null);
    const ctx = useMemo(() => ({ report: setCaptured }), []);
    const meta = search ?? captured;
    const showToolbar = !noToolbar && !!meta;
    const headerRight =
        actions || showToolbar ? (
            <HeaderRight>
                {actions}
                {showToolbar && meta && <PanelActions meta={meta} />}
            </HeaderRight>
        ) : null;
    const showHeader = title || subtitle || headerRight;
    const isClickable = !!onClick;
    return (
        <PanelMetaContext.Provider value={ctx}>
            <Root
                $compact={compact}
                $clickable={isClickable}
                className={className}
                onClick={onClick}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                title={isClickable ? clickTitle : undefined}
                aria-label={isClickable ? clickTitle : undefined}
                onKeyDown={
                    isClickable
                        ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  onClick && onClick();
                              }
                          }
                        : undefined
                }
            >
                {showHeader && (
                    <Header>
                        <div>
                            {title && <Title>{title}</Title>}
                            {subtitle && <Subtitle>{subtitle}</Subtitle>}
                        </div>
                        {headerRight}
                    </Header>
                )}
                <Body>{children}</Body>
            </Root>
        </PanelMetaContext.Provider>
    );
};

export default FramedPanel;
