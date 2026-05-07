import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import Dropdown from '@splunk/react-ui/Dropdown';
import Menu from '@splunk/react-ui/Menu';
import { logservTheme } from '../styles/logservTheme';
import { DashboardInfo } from '../routes/dashboardRegistry';

interface TriggerProps {
    $active?: boolean;
}

const Trigger = styled.button<TriggerProps>`
    background: ${(props) =>
        props.$active ? logservTheme.colors.hoverBackground : 'transparent'};
    color: ${logservTheme.colors.textActive};
    border: none;
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    border-bottom: 2px solid
        ${(props) => (props.$active ? logservTheme.colors.cyanAccent : 'transparent')};
    transition: background-color 80ms ease-out;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const Caret = styled.span`
    margin-left: ${logservTheme.spacing.xs};
    font-size: 10px;
    opacity: 0.7;
`;

/**
 * Wrap Menu.Item so the active dashboard within the category gets visually
 * marked — a left-border accent + cyan-light label color. This way users
 * always see which dashboard they're on when they open the category menu.
 */
const ItemWrap = styled.div<{ $selected: boolean }>`
    & > [role='menuitem'],
    & > div[role='menuitem'] {
        ${(p) =>
            p.$selected
                ? `
            background: ${logservTheme.colors.hoverBackground} !important;
            color: ${logservTheme.colors.cyanLight} !important;
            font-weight: ${logservTheme.fontWeight.semibold};
            border-left: 3px solid ${logservTheme.colors.cyanAccent};
            padding-left: calc(${logservTheme.spacing.md} - 3px);
        `
                : ''}
    }
`;

const CheckMark = styled.span`
    margin-right: ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.cyanLight};
    font-weight: ${logservTheme.fontWeight.bold};
`;

interface Props {
    label: string;
    items: DashboardInfo[];
    matchPathPrefix: string;
}

const NavCategoryDropdown: React.FC<Props> = ({ label, items, matchPathPrefix }) => {
    const location = useLocation();
    const navigate = useNavigate();
    const active = location.pathname.startsWith(matchPathPrefix);

    return (
        <Dropdown
            toggle={
                <Trigger $active={active}>
                    {label}
                    <Caret>{'▾'}</Caret>
                </Trigger>
            }
        >
            <Menu>
                {items.map((item) => {
                    const isCurrent = item.path === location.pathname;
                    return (
                        <ItemWrap key={item.slug} $selected={isCurrent}>
                            <Menu.Item onClick={() => navigate(item.path)}>
                                {isCurrent && <CheckMark>{'✓'}</CheckMark>}
                                {item.name}
                            </Menu.Item>
                        </ItemWrap>
                    );
                })}
            </Menu>
        </Dropdown>
    );
};

export default NavCategoryDropdown;
