import React from 'react';
import { useLocation } from 'react-router-dom';
import styled from 'styled-components';
import { DashboardInfo } from '../routes/dashboardRegistry';
import { useTimeRange } from '../state/TimeRangeProvider';
import { logservTheme } from '../styles/logservTheme';
import FramedPanel from './FramedPanel';
import DashboardLayout from './DashboardLayout';

const PrimaryLine = styled.div`
    font-size: ${logservTheme.fontSize.body};
    margin-bottom: ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textDefault};
`;

const SubtleLine = styled.div`
    font-size: ${logservTheme.fontSize.small};
    margin-top: ${logservTheme.spacing.xs};
    color: ${logservTheme.colors.textMuted};
    code {
        background: ${logservTheme.colors.tableHeaderBackground};
        padding: 1px 6px;
        border-radius: ${logservTheme.radius.small};
        font-family: monospace;
        color: ${logservTheme.colors.cyanLight};
    }
`;

interface Props {
    dashboard?: DashboardInfo;
    fallback?: boolean;
}

const PlaceholderDashboard: React.FC<Props> = ({ dashboard, fallback }) => {
    const location = useLocation();
    const { timeRange } = useTimeRange();

    if (fallback || !dashboard) {
        return (
            <DashboardLayout category="" title="Page not found">
                <FramedPanel title="Unknown route">
                    <PrimaryLine>
                        No dashboard is registered for the path <code>{location.pathname}</code>.
                    </PrimaryLine>
                </FramedPanel>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout
            category={dashboard.category.toUpperCase()}
            title={dashboard.name}
        >
            <FramedPanel title="Placeholder" subtitle="Dashboard not yet implemented">
                <PrimaryLine>
                    To be implemented in a later phase of v0.0.5.0.
                </PrimaryLine>
                <SubtleLine>
                    Time range: <code>{timeRange.earliest}</code> &rarr; <code>{timeRange.latest}</code>
                </SubtleLine>
                <SubtleLine>
                    Path: <code>{location.pathname}</code>
                </SubtleLine>
            </FramedPanel>
        </DashboardLayout>
    );
};

export default PlaceholderDashboard;
