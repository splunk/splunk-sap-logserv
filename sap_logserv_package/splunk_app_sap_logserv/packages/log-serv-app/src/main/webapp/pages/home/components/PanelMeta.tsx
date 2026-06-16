import React, { createContext, useContext, useEffect } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { useTimeRange } from '../state/TimeRangeProvider';
import {
    buildOpenInSearchUrl,
    buildJobInspectorUrl,
    buildResultsExportUrl,
    formatLastRun,
    openInNewTab,
} from '../utils/drilldownUrls';

/**
 * Build 234 — per-panel action toolbar infrastructure.
 *
 * Charts (TimeSeriesChart / PieChart) run their search internally, so they
 * REPORT their search metadata up to the nearest FramedPanel via this context
 * (`usePanelMetaReporter`). Tables receive their search externally, so their
 * dashboard passes the search result to FramedPanel via the explicit `search`
 * prop. Either way FramedPanel ends up with a `PanelMeta` and renders the
 * `PanelActions` toolbar (Open-in-Search / Download / Inspect / Refresh +
 * "&lt;1m ago") in its header.
 */

export interface PanelMeta {
    /** The dispatched SPL (for Open-in-Search). */
    spl: string;
    /** The dispatched job SID (for Inspect + Download); undefined until resolved. */
    sid?: string;
    /** Epoch-ms of the last dispatch (for the relative "last run" label). */
    dispatchedAt?: number;
    /** Re-run just this panel. */
    refresh?: () => void;
}

interface PanelMetaCtx {
    report: (meta: PanelMeta | null) => void;
}

/** Default is a no-op — useSearch consumers outside a FramedPanel (KPI cards,
 *  sparklines) report into the void harmlessly. */
export const PanelMetaContext = createContext<PanelMetaCtx>({ report: () => undefined });

/** Charts call this with their useSearch meta; it pushes the meta to the
 *  enclosing FramedPanel's context whenever the SID / SPL / dispatch time
 *  changes, and clears it on unmount. */
export const usePanelMetaReporter = (meta: PanelMeta): void => {
    const { report } = useContext(PanelMetaContext);
    useEffect(() => {
        report(meta);
        return () => report(null);
        // report identity is stable (FramedPanel's setState); re-report when
        // the meaningful fields change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meta.spl, meta.sid, meta.dispatchedAt, meta.refresh, report]);
};

// ---- toolbar UI ------------------------------------------------------------

const Bar = styled.div`
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
`;

const Stamp = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-right: 4px;
`;

const IconBtn = styled.button`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: ${logservTheme.radius.small};
    color: ${logservTheme.colors.textMuted};
    cursor: pointer;
    transition: color 100ms ease-out, background-color 100ms ease-out;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
        background: ${logservTheme.colors.hoverBackground};
    }
    &:disabled {
        opacity: 0.35;
        cursor: default;
    }
    svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
    }
`;

const SearchIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.2" /><line x1="10.2" y1="10.2" x2="14" y2="14" /></svg>
);
const DownloadIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden><line x1="8" y1="2.5" x2="8" y2="10" /><polyline points="4.5,7 8,10.5 11.5,7" /><line x1="3" y1="13.5" x2="13" y2="13.5" /></svg>
);
const InspectIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6" /><line x1="8" y1="7" x2="8" y2="11" /><circle cx="8" cy="4.6" r="0.4" fill="currentColor" stroke="none" /></svg>
);
const RefreshIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden><path d="M13 8 A5 5 0 1 1 11.5 4.5" /><polyline points="11.2,1.8 11.7,4.6 8.9,5.1" /></svg>
);

interface PanelActionsProps {
    meta: PanelMeta;
}

/** The 4-icon panel toolbar: Open in Search / Download / Inspect / Refresh,
 *  preceded by a "&lt;1m ago" last-run stamp. Inspect + Download disable until
 *  the SID resolves. Stops click-propagation so a clickable (drilldown) panel
 *  doesn't also fire its row/panel handler. */
export const PanelActions: React.FC<PanelActionsProps> = ({ meta }) => {
    const { timeRange } = useTimeRange();
    const { spl, sid, dispatchedAt, refresh } = meta;
    const stamp = formatLastRun(dispatchedAt);
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
        <Bar onClick={stop}>
            {stamp && <Stamp title="Last run">{stamp}</Stamp>}
            <IconBtn
                type="button"
                title="Open in Search"
                aria-label="Open in Search"
                onClick={(e) => {
                    stop(e);
                    openInNewTab(buildOpenInSearchUrl(spl, timeRange.earliest, timeRange.latest));
                }}
            >
                <SearchIcon />
            </IconBtn>
            <IconBtn
                type="button"
                title={sid ? 'Download results (CSV)' : 'Download (waiting for job…)'}
                aria-label="Download results"
                disabled={!sid}
                onClick={(e) => {
                    stop(e);
                    if (sid) openInNewTab(buildResultsExportUrl(sid, 'csv'));
                }}
            >
                <DownloadIcon />
            </IconBtn>
            <IconBtn
                type="button"
                title={sid ? 'Inspect search job' : 'Inspect (waiting for job…)'}
                aria-label="Inspect search job"
                disabled={!sid}
                onClick={(e) => {
                    stop(e);
                    if (sid) openInNewTab(buildJobInspectorUrl(sid));
                }}
            >
                <InspectIcon />
            </IconBtn>
            <IconBtn
                type="button"
                title="Refresh this panel"
                aria-label="Refresh this panel"
                disabled={!refresh}
                onClick={(e) => {
                    stop(e);
                    refresh && refresh();
                }}
            >
                <RefreshIcon />
            </IconBtn>
        </Bar>
    );
};
