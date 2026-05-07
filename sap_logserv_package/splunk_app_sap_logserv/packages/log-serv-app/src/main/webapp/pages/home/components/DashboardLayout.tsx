import React, { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import RefreshIntervalPicker from './RefreshIntervalPicker';
import DocsHelpIcon from './DocsHelpIcon';
import { RefreshProvider } from '../state/RefreshProvider';
import { dashboardIdFromPath } from '../state/dashboardRefreshPersistence';
import { resolveDocsUrl } from '../utils/docsLinks';

/**
 * DashboardLayout — shared page wrapper for dashboards.
 *
 * Provides the standard chrome: page padding, category eyebrow label, page
 * title, and optional subtitle. Children render below as the dashboard's
 * own content (KPI rows, panel grids, etc.).
 *
 * Wraps `children` in a `<RefreshProvider>` keyed by the URL path so each
 * dashboard gets its own auto-refresh cadence. The
 * `<RefreshIntervalPicker>` is always rendered on the right side of the
 * title row, alongside any caller-supplied `titleRowActions` content
 * (e.g., HostDetails' host picker). Build 155 / session 027.
 */

interface DashboardLayoutProps {
    category: string;
    title: ReactNode;
    subtitle?: ReactNode;
    /** Right-aligned slot in the title row, e.g., page-level filters. The
     *  RefreshIntervalPicker renders to the right of this slot, so callers
     *  don't need to opt in — every dashboard gets the picker for free. */
    titleRowActions?: ReactNode;
    children: ReactNode;
}

const Wrapper = styled.div`
    /* Top padding intentionally tighter than sides/bottom — the page header
     * (CategoryLabel + Title) is visually self-spaced; the navbar above
     * already provides ~30 px of breathing room via its own height. Used to
     * be ${logservTheme.spacing.xxl} all-around (32 px); reduced top to
     * ${logservTheme.spacing.lg} (16 px) in build 126 / session 024 per
     * user UX feedback that the title-area gap felt wasteful. Affects all
     * 22 dashboards uniformly via this single shared wrapper. */
    padding: ${logservTheme.spacing.lg} ${logservTheme.spacing.xxl} ${logservTheme.spacing.xxl};
    color: ${logservTheme.colors.textActive};
`;

const TitleRow = styled.div`
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: ${logservTheme.spacing.lg};
    margin-bottom: ${logservTheme.spacing.lg};
`;

const TitleBlock = styled.div`
    flex: 1 1 auto;
    min-width: 0;
`;

const ActionsBlock = styled.div`
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
`;

const CategoryLabel = styled.div`
    color: ${logservTheme.colors.textMuted};
    text-transform: uppercase;
    font-size: ${logservTheme.fontSize.small};
    letter-spacing: 1.5px;
    margin-bottom: ${logservTheme.spacing.xs};
`;

const TitleAndSubtitle = styled.div`
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: ${logservTheme.spacing.lg};
`;

const Title = styled.h1`
    margin: 0;
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.xxlarge};
    font-weight: ${logservTheme.fontWeight.bold};
`;

const Subtitle = styled.div`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
`;

const DashboardLayout: React.FC<DashboardLayoutProps> = ({
    category,
    title,
    subtitle,
    titleRowActions,
    children,
}) => {
    const location = useLocation();
    const dashboardId = dashboardIdFromPath(location.pathname);
    const docsUrl = resolveDocsUrl(location.pathname);

    return (
        // data-dashboard-root marks the capture target for the
        // NavigationBar's Actions menu (Download PNG / Download PDF). Every
        // dashboard goes through this wrapper, so the menu can locate the
        // current dashboard's root reliably without per-page wiring.
        <Wrapper data-dashboard-root="true">
            <RefreshProvider dashboardId={dashboardId}>
                <TitleRow>
                    <TitleBlock>
                        <CategoryLabel>{category}</CategoryLabel>
                        <TitleAndSubtitle>
                            <Title>{title}</Title>
                            {subtitle && <Subtitle>{subtitle}</Subtitle>}
                        </TitleAndSubtitle>
                    </TitleBlock>
                    <ActionsBlock>
                        {titleRowActions}
                        <RefreshIntervalPicker />
                        <DocsHelpIcon href={docsUrl} />
                    </ActionsBlock>
                </TitleRow>
                {children}
            </RefreshProvider>
        </Wrapper>
    );
};

export default DashboardLayout;
