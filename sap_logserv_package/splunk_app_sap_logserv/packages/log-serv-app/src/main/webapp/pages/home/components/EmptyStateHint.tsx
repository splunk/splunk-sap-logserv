import React from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { useCloudProvider } from '../state/CloudProviderProvider';
import { usePanelDiagnostic } from './PanelMeta';
import { explainEmptyPanel } from '../utils/panelDiagnosis';
import { useDiagnosticDrawer } from '../state/DiagnosticDrawerProvider';
import { rawTwinFor } from '../utils/rawTwin';

/**
 * EmptyStateHint — the one-line "why is this empty?" statement (session 093,
 * Phase 1 of the Missing-Data Diagnostic).
 *
 * WHY A STATEMENT AND NOT A LINK
 * ------------------------------
 * Every empty panel in the app currently asserts a cause: 76 of the 78
 * `emptyMessage` strings end in "…in this time range." That sentence is
 * frequently WRONG — the panel is just as likely empty because the global
 * Cloud filter is set to a provider with no data, because a host filter
 * matched nothing, or because the selected range is narrower than the panel's
 * hourly storage grain. Correcting the assertion is worth more than offering a
 * link, and it costs nothing: the checks behind it dispatch no searches (see
 * `utils/panelDiagnosis.ts`).
 *
 * The component renders NOTHING when there is nothing honest to say, which is
 * the common case. It never claims a system fault on free evidence alone.
 *
 * TWO WAYS TO FEED IT, because the two panel shapes differ:
 *   - CHARTS own their `useSearch`, so they pass the facts as props. Direct,
 *     and never a render behind.
 *   - TABLES receive their search from the dashboard, so `DataTable` has no
 *     idea what SPL produced its rows. It reads the enclosing `FramedPanel`'s
 *     `PanelDiagnosticContext` instead — which the panel already has, because
 *     every table call site passes `search={…}` for the toolbar.
 */

const Hint = styled.div<{ $compact?: boolean }>`
    margin-top: ${(p) => (p.$compact ? '0' : logservTheme.spacing.sm)};
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    line-height: 1.5;
    /* The parent StatusLine already centres and pads; inherit both. */
    max-width: 52ch;
    margin-left: auto;
    margin-right: auto;
    ${(p) =>
        p.$compact
            ? `
        text-align: left;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `
            : ''}
`;

export interface EmptyStateHintProps {
    /** The dispatched SPL. Omit to read the enclosing FramedPanel's context. */
    spl?: string;
    earliest?: string;
    latest?: string;
    dispatched?: boolean;
    loading?: boolean;
    errorMessage?: string | null;
    rowCount?: number | null;
    /** Cramped surface (KPI card): render the 2-5 word `short` form and move
     *  the full sentence into the tooltip, so the card grows by one short line
     *  rather than a wrapped paragraph. KPI cards sit in a height-equalising
     *  grid, so a tall hint on ONE card lifts the entire row. */
    compact?: boolean;
}

const DiagnoseLink = styled.button`
    display: inline;
    margin-left: 6px;
    padding: 0;
    background: transparent;
    border: none;
    color: ${logservTheme.colors.cyanLight};
    font: inherit;
    cursor: pointer;
    text-decoration: underline dotted;

    &:hover {
        color: ${logservTheme.colors.textActive};
    }
`;

const EmptyStateHint: React.FC<EmptyStateHintProps> = (props) => {
    const { provider } = useCloudProvider();
    const fromPanel = usePanelDiagnostic();
    const { open } = useDiagnosticDrawer();

    // Props win; the panel context is the fallback for components that do not
    // own their search.
    const spl = props.spl ?? fromPanel?.spl;
    if (!spl) return null;

    const facts = {
        spl,
        earliest: props.earliest ?? fromPanel?.effectiveEarliest ?? '',
        latest: props.latest ?? fromPanel?.effectiveLatest ?? '',
        dispatched: props.dispatched ?? fromPanel?.dispatched ?? true,
        loading: props.loading ?? false,
        errorMessage: props.errorMessage ?? null,
        rowCount: props.rowCount ?? fromPanel?.rowCount ?? null,
        cloudProvider: provider,
        // §17.8a-15 — resolve the raw twin HERE (not via the registry). Hits
        // only when this exact cached SPL was routed at a wide window; null
        // otherwise (already-raw, or no twin), which check 21 handles.
        rawAlternate: rawTwinFor(spl),
    };
    const verdict = explainEmptyPanel(facts);

    /* THE ENTRY POINT IS NOT GATED ON THE VERDICT (design §12.4).
     *
     * `explainEmptyPanel` returns null in the COMMON case — a panel whose
     * search succeeded and simply returned nothing, with no error, no lint, no
     * filter and no grain mismatch. That is precisely the panel for which only
     * dispatched evidence can say anything. Hanging the "Run full diagnosis"
     * affordance off the verdict would therefore hide it exactly where it is
     * needed and show it where the answer is already on screen.
     *
     * Suppressed in `compact` (KPI) mode: a KPI card has ONE bottom slot in an
     * exclusive-or chain, and its grid equalises row heights, so an extra
     * element there lifts every card in the row — and KpiCard has no
     * interactive-descendant guard, so a nested button would also fire the
     * card's own drilldown. */
    const canDiagnose = !props.compact && !facts.loading && !!facts.spl;
    if (!verdict && !canDiagnose) return null;

    const label = verdict ? 'Run full diagnosis' : 'Why is this empty?';
    const link = canDiagnose ? (
        <DiagnoseLink
            type="button"
            onClick={(e) => {
                // FramedPanel and several KPI cards are themselves clickable.
                e.stopPropagation();
                open({ title: fromPanel?.title || '', facts });
            }}
        >
            {label}
        </DiagnoseLink>
    ) : null;

    if (!verdict) {
        return <Hint data-diagnostic-verdict="none">{link}</Hint>;
    }

    // Headline only — one line. `detail` goes in the tooltip so the panel's
    // height changes by a single line at most; a KPI row and a PanelGrid both
    // equalise heights, so a two-line hint on one panel would lift its whole
    // row (see the layout note in the design doc, §6.1).
    const full = verdict.detail ? `${verdict.headline} ${verdict.detail}` : verdict.headline;
    return (
        <Hint
            $compact={!!props.compact}
            title={props.compact ? full : verdict.detail || undefined}
            data-diagnostic-verdict={verdict.id}
        >
            {props.compact ? verdict.short : verdict.headline}
            {link}
        </Hint>
    );
};

export default EmptyStateHint;
