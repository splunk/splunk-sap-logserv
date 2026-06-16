import React from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import Spinner from './Spinner';

/**
 * Shared "panel is loading" indicator (build 234). Renders the orange-dot
 * Spinner above a muted "Loading data…" label, centered in the panel body.
 * Used by every data viz (TimeSeriesChart / PieChart / DataTable) in place of
 * the old literal "Loading…" text so every panel shows the same in-flight
 * visual language as the topology canvas overlay ("Loading data & layout…").
 */

const Wrap = styled.div<{ $height?: number }>`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    ${(p) => (p.$height ? `height: ${p.$height}px;` : 'min-height: 80px;')}
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

interface PanelLoadingProps {
    /** Fixed height (px) to match the panel's chart height; omit for tables
     *  (they size to content with a sensible min-height). */
    height?: number;
    /** Override the label text. Default "Loading data…". */
    label?: string;
}

const PanelLoading: React.FC<PanelLoadingProps> = ({ height, label = 'Loading data…' }) => (
    <Wrap $height={height} role="status" aria-label={label}>
        <Spinner radius={11} dotSize={3.5} label={label} />
        <span>{label}</span>
    </Wrap>
);

export default PanelLoading;
