import React, { ReactNode } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

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

interface FramedPanelProps {
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
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
    compact,
    children,
    className,
    onClick,
    clickTitle,
}) => {
    const showHeader = title || subtitle || actions;
    const isClickable = !!onClick;
    return (
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
                    {actions && <div>{actions}</div>}
                </Header>
            )}
            <Body>{children}</Body>
        </Root>
    );
};

export default FramedPanel;
