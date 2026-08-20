import React, { createContext, useContext, useEffect, useState } from 'react';
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
import { useDiagnosticDrawer } from '../state/DiagnosticDrawerProvider';
import { useCloudProvider } from '../state/CloudProviderProvider';
import { getActivePageSnapshot } from '../state/DiagnosticCollector';
import { rawTwinFor } from '../utils/rawTwin';
import { coverageFor } from '../utils/columnCoverage';
import { resolveColumnOrigins, ColumnOrigin } from '../utils/splProbe';
import { isDiagnosisActive, subscribeDiagnosisActive } from '../utils/diagProbe';

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

    /* --- session 093: diagnostic fields ---------------------------------
     * All optional, and all named to match `UseSearchResult` exactly, so the
     * ~93 call sites that already pass `search={someUseSearchResult}` to
     * FramedPanel gain them for free — a UseSearchResult is structurally a
     * PanelMeta. Charts, which report rather than receive, pass them through
     * `usePanelMetaReporter`. */

    /** The window the search actually ran over (NOT the picker's current
     *  value — a few panels override the range). */
    effectiveEarliest?: string;
    effectiveLatest?: string;
    /** Rows returned; null when nothing has arrived yet. */
    rowCount?: number | null;
    /** False when the search was deliberately not dispatched. */
    dispatched?: boolean;
    /** The panel's user-visible title. Session 095 — the diagnosis drawer names
     *  the panel it was opened from, and FramedPanel is the only place that
     *  knows it. Set by FramedPanel when it provides PanelDiagnosticContext;
     *  charts reporting UP never set it. */
    title?: string;
}

interface PanelMetaCtx {
    report: (meta: PanelMeta | null) => void;
}

/** Default is a no-op — useSearch consumers outside a FramedPanel (KPI cards,
 *  sparklines) report into the void harmlessly. */
export const PanelMetaContext = createContext<PanelMetaCtx>({ report: () => undefined });

/**
 * The SAME metadata, flowing DOWN (session 093).
 *
 * `PanelMetaContext` carries a panel's search metadata UP from an inner chart.
 * This one carries the resolved metadata back DOWN to any descendant that
 * needs to explain itself — specifically `DataTable`, which is handed only
 * `rows` / `loading` / `error` and therefore cannot know which query produced
 * its empty state.
 *
 * Provided by `FramedPanel` from the same `meta = search ?? captured` value
 * that drives the toolbar, so tables get it with no call-site changes.
 *
 * Charts do NOT read this — they own their search and pass the facts to
 * `EmptyStateHint` directly, which avoids the one-render lag inherent in
 * report-up-then-provide-down.
 */
/* §14.6 (build 313): the context's value is `Partial<PanelMeta>`, NOT
 * PanelMeta — a chart-owning panel has no `search` prop to spread, yet its
 * TITLE must still reach the drawer/report (previously those panels provided
 * NO context and every report from them read "Panel diagnosis — (untitled)").
 * PanelMeta itself keeps `spl` required (PanelActions dereferences it
 * unguarded); every consumer of THIS context already optional-chains, and
 * EmptyStateHint bails on a missing spl, so a title-only value degrades
 * identically to the old null for everything except the title. */
export const PanelDiagnosticContext = createContext<Partial<PanelMeta> | null>(null);

/** Read the enclosing FramedPanel's search metadata, if there is one. */
export const usePanelDiagnostic = (): Partial<PanelMeta> | null =>
    useContext(PanelDiagnosticContext);

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
        // Session 093 note: the diagnostic fields (effectiveEarliest/Latest,
        // rowCount, dispatched) are intentionally NOT in this dep list. They
        // ride along on whatever object is reported, and re-reporting on every
        // rowCount change would fire this effect on each streaming re-emit for
        // no benefit — the toolbar does not use them, and charts feed
        // EmptyStateHint directly rather than through this context.
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
/** §18.1 — the Diagnose (pulse) glyph. Exported for KpiCard's corner
 *  affordance so the two entries share one visual. */
export const DiagnoseIcon = () => (
    <svg viewBox="0 0 16 16" aria-hidden><polyline points="1.5,8.5 4.5,8.5 6,4 8.5,12 10,8.5 14.5,8.5" /></svg>
);

/** §18.8a-24 — a REACTIVE view of the diagnosis singleton, so the Diagnose
 *  affordances re-render on begin/end. The click handler's imperative
 *  `isDiagnosisActive()` check remains the actual enforcement. */
export const useDiagnosisActive = (): boolean => {
    const [active, setActive] = useState(isDiagnosisActive());
    useEffect(() => subscribeDiagnosisActive(() => setActive(isDiagnosisActive())), []);
    return active;
};

interface PanelActionsProps {
    meta: PanelMeta;
    /** The panel's user-visible title, passed by FramedPanel (the toolbar
     *  renders OUTSIDE the diagnostic context provider — §18.8a-26). */
    title?: string;
}

/** The 4-icon panel toolbar: Open in Search / Download / Inspect / Refresh,
 *  preceded by a "&lt;1m ago" last-run stamp. Inspect + Download disable until
 *  the SID resolves. Stops click-propagation so a clickable (drilldown) panel
 *  doesn't also fire its row/panel handler. */
export const PanelActions: React.FC<PanelActionsProps> = ({ meta, title }) => {
    const { timeRange } = useTimeRange();
    const { open: openDrawer, isOpen: drawerOpen } = useDiagnosticDrawer();
    const { provider } = useCloudProvider();
    const diagActive = useDiagnosisActive();
    const { spl, sid, dispatchedAt, refresh } = meta;
    const stamp = formatLastRun(dispatchedAt);
    const stop = (e: React.MouseEvent) => e.stopPropagation();

    /* §18.1/§18.8a-4 — the always-available Diagnose entry. Facts come from
     * the meta when it carries the diagnostic fields (the explicit
     * `search`-prop panels); a CHART's captured meta carries only the four
     * toolbar fields, so the page registry (live per-search primitives for
     * every hook, charts included) fills the gap at CLICK time. EmptyStateHint's
     * defensive defaults apply on top; a window that stays unknown makes the
     * drawer REFUSE to dispatch (§18.8a-5) rather than probe all-time. */
    const openDiagnosis = (): void => {
        let earliest = meta.effectiveEarliest;
        let latest = meta.effectiveLatest;
        let rowCount = meta.rowCount;
        let dispatched = meta.dispatched;
        let errorMessage: string | null = null;
        if (earliest === undefined || rowCount === undefined) {
            const reg = getActivePageSnapshot().find((r) => r.spl === spl);
            if (reg) {
                earliest = earliest ?? reg.earliest;
                latest = latest ?? reg.latest;
                if (rowCount === undefined) rowCount = reg.rowCount;
                if (dispatched === undefined) dispatched = reg.dispatched;
                errorMessage = reg.errorMessage;
            }
        }
        const coverage = coverageFor(spl);
        let columnOrigins: Record<string, ColumnOrigin> | null = null;
        if (coverage) {
            const blanks = coverage.columns
                .filter((c) => c.populated === 0 && !c.hasRender)
                .map((c) => c.key);
            if (blanks.length > 0) columnOrigins = resolveColumnOrigins(spl, blanks);
        }
        openDrawer({
            title: title || '',
            facts: {
                spl,
                earliest: earliest ?? '',
                latest: latest ?? '',
                dispatched: dispatched ?? true,
                loading: false,
                errorMessage,
                rowCount: rowCount ?? null,
                cloudProvider: provider,
                rawAlternate: rawTwinFor(spl),
            },
            columnCoverage: coverage,
            columnOrigins,
        });
    };

    return (
        <Bar onClick={stop}>
            {stamp && <Stamp title="Last run">{stamp}</Stamp>}
            <IconBtn
                type="button"
                title={
                    drawerOpen || diagActive
                        ? 'A diagnosis is already running'
                        : 'Diagnose this panel'
                }
                aria-label="Diagnose this panel"
                disabled={drawerOpen || diagActive}
                onClick={(e) => {
                    stop(e);
                    // §18.8a-24 — the imperative check is the guard: a click
                    // during a sweep must NO-OP, never silently supersede a
                    // three-minute run.
                    if (isDiagnosisActive()) return;
                    openDiagnosis();
                }}
            >
                <DiagnoseIcon />
            </IconBtn>
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
