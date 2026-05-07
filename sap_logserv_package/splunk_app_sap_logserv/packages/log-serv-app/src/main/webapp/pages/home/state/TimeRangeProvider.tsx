import React, { createContext, useContext, useMemo, useState, ReactNode } from 'react';

export interface TimeRange {
    earliest: string;
    latest: string;
}

interface TimeRangeContextValue {
    timeRange: TimeRange;
    setTimeRange: (next: TimeRange) => void;
}

const DEFAULT_RANGE: TimeRange = { earliest: '-30d@d', latest: 'now' };

const TimeRangeContext = createContext<TimeRangeContextValue | undefined>(undefined);

interface ProviderProps {
    children: ReactNode;
    initial?: TimeRange;
}

/**
 * Parse `earliest` + `latest` from the current URL hash query string.
 * Returns null when either is missing or empty.
 *
 * HashRouter convention: the query string lives AFTER the route, so the
 * URL is `home#/platform/host-details?earliest=-7d&latest=now`. We can't
 * use `URLSearchParams(window.location.search)` because that reads the
 * pre-hash query string, which is empty for our app.
 *
 * Used by drilldowns from other dashboards (build 157): when a drilldown
 * link opens a fresh new-tab navigation, we want the destination
 * dashboard to honor the source dashboard's time range instead of
 * defaulting back to `-30d@d`/`now`. The drilldown URL builder in
 * `utils/drilldownUrls.ts` embeds the params; this parser hydrates them
 * back on the destination's first mount.
 */
const parseRangeFromHash = (): TimeRange | null => {
    try {
        const hash = window.location.hash || '';
        const queryIndex = hash.indexOf('?');
        if (queryIndex === -1) return null;
        const queryString = hash.slice(queryIndex + 1);
        const params = new URLSearchParams(queryString);
        const earliest = params.get('earliest');
        const latest = params.get('latest');
        if (!earliest || !latest) return null;
        return { earliest, latest };
    } catch (_e) {
        return null;
    }
};

export const TimeRangeProvider: React.FC<ProviderProps> = ({ children, initial }) => {
    // Initial range precedence: explicit `initial` prop > URL params > default.
    // Computed once at mount via the lazy initializer so subsequent URL
    // changes (e.g., user navigating between dashboards within the same tab
    // via the in-app NavigationBar) don't re-hydrate from URL — by then the
    // user's TimeRange picker is the source of truth.
    const [timeRange, setTimeRange] = useState<TimeRange>(
        () => initial ?? parseRangeFromHash() ?? DEFAULT_RANGE,
    );
    const value = useMemo<TimeRangeContextValue>(
        () => ({ timeRange, setTimeRange }),
        [timeRange]
    );
    return <TimeRangeContext.Provider value={value}>{children}</TimeRangeContext.Provider>;
};

export const useTimeRange = (): TimeRangeContextValue => {
    const ctx = useContext(TimeRangeContext);
    if (!ctx) {
        throw new Error('useTimeRange must be used inside a TimeRangeProvider');
    }
    return ctx;
};
