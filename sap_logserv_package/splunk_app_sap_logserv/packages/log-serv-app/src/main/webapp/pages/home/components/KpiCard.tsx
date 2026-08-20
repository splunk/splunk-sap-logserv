import React, { ReactNode } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import Spinner from './Spinner';
import EmptyStateHint from './EmptyStateHint';
import { PanelMeta, useDiagnosisActive, DiagnoseIcon } from './PanelMeta';
import { explainEmptyPanel } from '../utils/panelDiagnosis';
import { useCloudProvider } from '../state/CloudProviderProvider';
import { useDiagnosticDrawer } from '../state/DiagnosticDrawerProvider';
import { rawTwinFor } from '../utils/rawTwin';
import { isDiagnosisActive } from '../utils/diagProbe';
// styled-components needs to be imported above; SparklineSlot uses styled.div

/**
 * KpiCard — compact KPI tile for dashboard headers.
 *
 * Header label (small, muted) over a big numeric value, with optional
 * status coloring (red/green/orange/yellow) and a delta line. Designed
 * to be used in a row inside a `<KpiRow>` container.
 */

export type KpiTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'severe';

/** Tone → sentiment token (Magnetic vocabulary, §6 build 254):
 *  positive = sentiment green (was teal pre-re-theme). */
const toneToColor: Record<KpiTone, string> = {
    neutral: logservTheme.colors.textActive,
    positive: logservTheme.colors.green,
    warning: logservTheme.colors.orange,
    critical: logservTheme.colors.red,
    severe: logservTheme.colors.redSevere,
};

const Card = styled.div<{ $clickable: boolean }>`
    /* Magnetic basic-statistics card (§6, build 254) — same container-card
       chrome as FramedPanel: 4px radius, resting xs shadow, interact-accent
       hover at 150ms. */
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.medium};
    padding: ${logservTheme.spacing.lg};
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 120px;
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.05);
    /* §18.8a-25 — the positioned ancestor for the corner Diagnose affordance
       (harmless to the height-equalising grid stretch). */
    position: relative;

    /* Hover/focus-reveal for the affordance; always in the tab order, and
       visible at low opacity so touch users can reach it. */
    .kpi-diagnose {
        opacity: 0.25;
        transition: opacity 120ms ease-out;
    }
    &:hover .kpi-diagnose,
    &:focus-within .kpi-diagnose {
        opacity: 1;
    }

    ${(p) =>
        p.$clickable
            ? `
        cursor: pointer;
        transition: border-color 150ms ease-out, box-shadow 150ms ease-out;

        &:hover {
            border-color: ${logservTheme.colors.cyanAccent};
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        }

        &:focus-visible {
            outline: 2px solid ${logservTheme.colors.focusRing};
            outline-offset: 2px;
        }
    `
            : ''}
`;

const Label = styled.div`
    /* KPI card labels match FramedPanel's panel-title treatment — textActive
       (white in dark / near-black in light) at 14px semibold — so KPI tiles
       and chart panels read as one title system (user feedback, build 255;
       the Magnetic secondary-muted label tried in build 254 was rejected).
       Sentence case stays (uppercase dropped in build 254 per §6). */
    color: ${logservTheme.colors.textActive};
    font-size: 14px;
    font-weight: ${logservTheme.fontWeight.semibold};
    margin-bottom: ${logservTheme.spacing.sm};
`;

const Value = styled.div<{ $tone: KpiTone; $loading: boolean }>`
    color: ${(p) => (p.$loading ? logservTheme.colors.textMuted : toneToColor[p.$tone])};
    /* Magnetic statistics value: 32px semibold (was 36px bold), §6 b254. */
    font-size: 32px;
    font-weight: ${logservTheme.fontWeight.semibold};
    line-height: 1.1;
    font-feature-settings: 'tnum' 1;
`;

const Sub = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-top: ${logservTheme.spacing.xs};
`;

const ErrorLine = styled.div`
    color: ${logservTheme.colors.red};
    font-size: ${logservTheme.fontSize.small};
    margin-top: ${logservTheme.spacing.xs};
`;

/** §18.8a-25 — the corner Diagnose affordance. Absolutely positioned inside
 *  the (now relative) Card so it never participates in the height-equalising
 *  grid; revealed on hover/focus-within, always tabbable. */
const DiagnoseCorner = styled.button`
    position: absolute;
    top: 6px;
    right: 6px;
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

    &:hover {
        color: ${logservTheme.colors.cyanLight};
        background: ${logservTheme.colors.hoverBackground};
    }
    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: 1px;
        opacity: 1;
    }
    &:disabled {
        opacity: 0.2;
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

interface KpiCardProps {
    label: ReactNode;
    /** Raw value (typically from a Splunk search result). Will be stringified
     * unless `formatValue` is provided. */
    value?: unknown;
    sub?: ReactNode;
    tone?: KpiTone;
    loading?: boolean;
    error?: Error | null;
    formatValue?: (raw: unknown) => string;
    /** Optional inline trend line below the value (e.g., <SparklineFromQuery />). */
    sparkline?: ReactNode;
    /** Click handler — when set, the whole card becomes interactive
     *  (cursor: pointer + hover state). Used for drilldowns from the
     *  Environment Health KPI row to per-domain dashboards.
     *  Build 157 / session 027 task 4. */
    onClick?: () => void;
    /** Tooltip / aria-label when the card is clickable. */
    clickTitle?: string;
    /** Session 093 — the search behind this KPI, so the card can explain a
     *  missing value. Optional; without it the card behaves exactly as before.
     *
     *  A KPI card is handed a scalar, not a search, so unlike a chart it cannot
     *  work out its own query. Each dashboard's local `useFirstRowField(Hybrid)`
     *  helper now returns the search result alongside the value and the 84 call
     *  sites pass it through.
     *
     *  Why this matters here specifically: an em-dash means the search returned
     *  zero ROWS, whereas `0` means a row came back carrying zero. For a
     *  `| stats count` over live events the former is anomalous; for an
     *  `| inputlookup` without the empty-safe idiom it is the signature of a
     *  rollup that was never backfilled. */
    search?: PanelMeta;
}

const KpiCard: React.FC<KpiCardProps> = ({
    label,
    value,
    sub,
    tone = 'neutral',
    loading = false,
    error = null,
    formatValue,
    sparkline,
    onClick,
    clickTitle,
    search,
}) => {
    let displayValue: ReactNode;
    if (loading) {
        // build 234: orange-dot spinner in place of the old "—" while the KPI
        // search is in flight (consistent with the chart/table PanelLoading).
        displayValue = <Spinner radius={8} dotSize={3} label="Loading" />;
    } else if (error) {
        displayValue = '!';
    } else if (formatValue && typeof value !== 'undefined') {
        displayValue = formatValue(value);
    } else if (typeof value === 'undefined' || value === null) {
        displayValue = '—';
    } else {
        displayValue = String(value);
    }

    const { provider } = useCloudProvider();
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    const nothingToShow =
        !loading &&
        !error &&
        (typeof value === 'undefined' || value === null || (!Number.isNaN(numeric) && numeric === 0));
    /* The hint may take over the `sub` slot ONLY when it will actually render
     * something. In compact mode `EmptyStateHint` returns null whenever no
     * verdict exists — but a React ELEMENT is truthy regardless of what it
     * renders, so testing the element replaced the caller's `sub` content
     * (Multi-Cloud's sparklines) with an empty div on every zero-valued card
     * (session 095, finding 10). The verdict is therefore computed here with
     * the SAME facts EmptyStateHint builds internally, so gate and render
     * cannot disagree; `explainEmptyPanel` is a memoised pure function, so the
     * double computation costs nothing. */
    const verdict =
        nothingToShow && search && search.spl
            ? explainEmptyPanel({
                  spl: search.spl,
                  earliest: search.effectiveEarliest ?? '',
                  latest: search.effectiveLatest ?? '',
                  dispatched: search.dispatched ?? true,
                  loading: false,
                  errorMessage: null,
                  rowCount: search.rowCount ?? null,
                  cloudProvider: provider,
              })
            : null;
    const hint =
        verdict && search ? (
            <EmptyStateHint
                compact
                spl={search.spl}
                earliest={search.effectiveEarliest}
                latest={search.effectiveLatest}
                dispatched={search.dispatched}
                rowCount={search.rowCount}
            />
        ) : null;

    /* §18.8a-7 — the zero-state derivation for the Diagnose entry. A formatted
     * zero ("0 ms", "0%", "0 B") counts via the leading-numeric-run parse; an
     * empty string is UNKNOWN, never zero (`Number('') === 0` was the review's
     * H-F17d trap); an absent value (the em-dash) counts. */
    const zeroState = ((): boolean => {
        if (loading || error) return false;
        if (typeof value === 'undefined' || value === null) return true;
        if (typeof value === 'number') return value === 0;
        const s = String(value).trim();
        if (s === '') return false;
        const lead = s.replace(/,/g, '').match(/^-?\d+(\.\d+)?/);
        return lead ? Number(lead[0]) === 0 : false;
    })();

    const drawer = useDiagnosticDrawer();
    const diagActive = useDiagnosisActive();
    const canDiagnose = !!(search && search.spl);
    const openKpiDiagnosis = (): void => {
        if (!search || !search.spl) return;
        // §18.8a-24 — the imperative check is the guard.
        if (isDiagnosisActive()) return;
        drawer.open({
            title: typeof label === 'string' ? label : '',
            facts: {
                spl: search.spl,
                earliest: search.effectiveEarliest ?? '',
                latest: search.effectiveLatest ?? '',
                dispatched: search.dispatched ?? true,
                loading: false,
                errorMessage: error ? error.message || 'Search failed' : null,
                rowCount: search.rowCount ?? null,
                cloudProvider: provider,
                rawAlternate: rawTwinFor(search.spl),
                zeroValued: zeroState,
            },
        });
    };

    /* §18.8a-25 — the FramedPanel-style interactive-descendant guard, applied
     * to BOTH click and keydown: Enter on the nested Diagnose button must not
     * fire the card's drilldown (stopPropagation on click alone cannot prevent
     * the keydown path — the review's H-F13/W-5). */
    const isClickable = !!onClick;
    const guardedClick = isClickable
        ? (e: React.MouseEvent) => {
              const t = e.target as HTMLElement | null;
              const interactive = t && t.closest ? t.closest('button, a, input, select, textarea') : null;
              if (interactive && interactive !== e.currentTarget) return;
              onClick && onClick();
          }
        : undefined;
    return (
        <Card
            $clickable={isClickable}
            onClick={guardedClick}
            role={isClickable ? 'button' : undefined}
            tabIndex={isClickable ? 0 : undefined}
            title={isClickable ? clickTitle : undefined}
            aria-label={isClickable ? clickTitle : undefined}
            onKeyDown={
                isClickable
                    ? (e) => {
                          if (e.target !== e.currentTarget) return; // §18.8a-25
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onClick && onClick();
                          }
                      }
                    : undefined
            }
        >
            {canDiagnose && (
                <DiagnoseCorner
                    type="button"
                    className="kpi-diagnose"
                    title={diagActive || drawer.isOpen ? 'A diagnosis is already running' : 'Diagnose this panel'}
                    aria-label="Diagnose this panel"
                    disabled={diagActive || drawer.isOpen}
                    onClick={(e) => {
                        e.stopPropagation();
                        openKpiDiagnosis();
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <DiagnoseIcon />
                </DiagnoseCorner>
            )}
            <Label>{label}</Label>
            <Value $tone={tone} $loading={loading}>
                {displayValue}
            </Value>
            {sparkline && <SparklineSlot>{sparkline}</SparklineSlot>}
            {error ? (
                <ErrorLine>{error.message || 'Search failed'}</ErrorLine>
            ) : hint ? (
                <Sub>{hint}</Sub>
            ) : sub ? (
                <Sub>{sub}</Sub>
            ) : null}
        </Card>
    );
};

const SparklineSlot = styled.div`
    margin-top: ${logservTheme.spacing.xs};
`;

export default KpiCard;

/**
 * Helper: turn an integer-like value into a human-readable string with thousands separators.
 * Use as `formatValue` prop on KpiCard for count-style metrics.
 */
export const formatInteger = (raw: unknown): string => {
    if (raw === null || typeof raw === 'undefined') return '—';
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
    if (Number.isNaN(n)) return String(raw);
    return n.toLocaleString('en-US');
};
