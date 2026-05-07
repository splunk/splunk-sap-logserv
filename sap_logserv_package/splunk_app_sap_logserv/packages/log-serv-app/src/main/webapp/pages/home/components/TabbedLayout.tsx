import React, { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import styled from 'styled-components';
import TabBar from '@splunk/react-ui/TabBar';
import { logservTheme } from '../styles/logservTheme';

/**
 * TabbedLayout — URL-backed multi-tab layout for dashboards.
 *
 * The active tab is encoded in the `?tab=<id>` query string (compatible
 * with HashRouter), so deep links to a specific tab work and the browser
 * back/forward buttons navigate between tabs.
 *
 * Use for Host Details (3 tabs: Overview / Role Activity / Sourcetype
 * Mapping) and Data Pipeline Overview (2 tabs: Overview / Linked Graph).
 */

export interface TabDef {
    id: string;
    label: string;
    content: ReactNode;
}

interface TabbedLayoutProps {
    tabs: TabDef[];
    /** Query-param key for the active tab. Defaults to "tab". */
    paramKey?: string;
}

const TabBarWrap = styled.div`
    margin-bottom: ${logservTheme.elevation.panelGap};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const TabPanel = styled.div`
    /* Tabs render their own content area; no extra padding needed */
`;

const TabbedLayout: React.FC<TabbedLayoutProps> = ({ tabs, paramKey = 'tab' }) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const requested = searchParams.get(paramKey);
    const activeId =
        tabs.find((t) => t.id === requested)?.id ?? tabs[0]?.id ?? '';

    const handleChange = (
        _e: React.SyntheticEvent,
        { selectedTabId }: { selectedTabId?: string }
    ) => {
        if (!selectedTabId) return;
        const next = new URLSearchParams(searchParams);
        if (selectedTabId === tabs[0]?.id) {
            // First tab is the default; omit the param to keep URLs clean.
            next.delete(paramKey);
        } else {
            next.set(paramKey, selectedTabId);
        }
        setSearchParams(next, { replace: false });
    };

    const activeTab = tabs.find((t) => t.id === activeId);

    return (
        <>
            <TabBarWrap>
                <TabBar activeTabId={activeId} onChange={handleChange}>
                    {tabs.map((t) => (
                        <TabBar.Tab key={t.id} tabId={t.id} label={t.label} />
                    ))}
                </TabBar>
            </TabBarWrap>
            <TabPanel>{activeTab ? activeTab.content : null}</TabPanel>
        </>
    );
};

export default TabbedLayout;
