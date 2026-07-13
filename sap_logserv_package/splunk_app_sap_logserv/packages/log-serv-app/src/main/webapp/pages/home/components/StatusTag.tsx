import React, { ReactNode } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

/**
 * StatusTag — Magnetic sentiment tag (§6, Phase 1b / build 254).
 *
 * Pastel sentiment-tint background + strong sentiment text, 2px radius —
 * the Magnetic idiom for severity / status values in tables and lists
 * (replaces bare colored text). The tint/strong pairs are the `*Tint`
 * tokens from magneticTokens.ts, which resolve per mode via the CSS
 * variable layer, so this component is mode-agnostic.
 *
 * Adoption: severity/status table cells across the dashboards + the
 * AuditLogViewer category chips (the call-site sweep is Phase 4; this
 * component ships in 1b so the sweep is a rendering-only change).
 *
 *   <StatusTag sentiment="negative">ERROR</StatusTag>
 *   <StatusTag sentiment={sentimentForValue(row.severity)}>{row.severity}</StatusTag>
 */

export type Sentiment = 'positive' | 'warning' | 'severe' | 'negative' | 'info' | 'dormant';

const SENTIMENT_STYLES: Record<Sentiment, { bg: string; fg: string }> = {
    positive: { bg: logservTheme.colors.positiveTint, fg: logservTheme.colors.green },
    warning: { bg: logservTheme.colors.warningTint, fg: logservTheme.colors.orange },
    severe: { bg: logservTheme.colors.severeTint, fg: logservTheme.colors.redLight },
    negative: { bg: logservTheme.colors.negativeTint, fg: logservTheme.colors.red },
    info: { bg: logservTheme.colors.infoTint, fg: logservTheme.colors.info },
    dormant: { bg: logservTheme.colors.dormantTint, fg: logservTheme.colors.dormant },
};

const Tag = styled.span<{ $sentiment: Sentiment }>`
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 2px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    line-height: 1.5;
    white-space: nowrap;
    background: ${(p) => SENTIMENT_STYLES[p.$sentiment].bg};
    color: ${(p) => SENTIMENT_STYLES[p.$sentiment].fg};
`;

interface StatusTagProps {
    sentiment: Sentiment;
    children: ReactNode;
    className?: string;
    title?: string;
}

const StatusTag: React.FC<StatusTagProps> = ({ sentiment, children, className, title }) => (
    <Tag $sentiment={sentiment} className={className} title={title}>
        {children}
    </Tag>
);

export default StatusTag;

/** Map a severity / status / risk string onto a sentiment. Mirrors the
 *  semantics of chartPalettes.statusFieldColors so tags and chart series
 *  agree on what's red. Unrecognized values → dormant (neutral gray). */
export const sentimentForValue = (raw: unknown): Sentiment => {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v) return 'dormant';
    if (['error', 'fatal', 'critical', 'high', '5xx', 'failure', 'failed', 'denied', 'blocked'].includes(v)) {
        return 'negative';
    }
    if (['warning', 'warn', 'medium', '4xx'].includes(v)) return 'severe';
    if (['info', 'informational', 'low', '3xx'].includes(v)) return 'info';
    if (['success', 'successful', 'ok', '2xx', 'allowed', 'passed'].includes(v)) return 'positive';
    return 'dormant';
};
