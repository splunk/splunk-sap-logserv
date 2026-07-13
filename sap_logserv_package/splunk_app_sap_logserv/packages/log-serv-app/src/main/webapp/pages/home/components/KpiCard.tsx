import React, { ReactNode } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import Spinner from './Spinner';
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

    const isClickable = !!onClick;
    return (
        <Card
            $clickable={isClickable}
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
            <Label>{label}</Label>
            <Value $tone={tone} $loading={loading}>
                {displayValue}
            </Value>
            {sparkline && <SparklineSlot>{sparkline}</SparklineSlot>}
            {error ? <ErrorLine>{error.message || 'Search failed'}</ErrorLine> : sub ? <Sub>{sub}</Sub> : null}
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
