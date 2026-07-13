import React from 'react';
import { logservTheme } from '../../../styles/logservTheme';

/**
 * Inline SVG database cylinder — shared between PartnerNode (renders in
 * place of the default hexagon glyph) and SidNode (renders inside the disc
 * above the SID label, when tag === 'DB').
 *
 * Theme-matched: cyanLight top ellipse, dark fill body with cyanAccent
 * stroke, two faint horizontal disc lines for the classic stack-of-disks
 * database silhouette.
 */
const CylinderIcon: React.FC<{ width?: number; height?: number }> = ({
    width = 22,
    height = 26,
}) => (
    /* Phase 0 Magnetic re-theme (build 246): fill/stroke moved from SVG
     * ATTRIBUTES to inline `style` — logservTheme colors are var(--lsv-*)
     * references now, which resolve in CSS positions (inline style) but
     * NOT in attribute positions. Mode flips restyle the icon for free. */
    <svg viewBox="0 0 24 30" width={width} height={height} aria-hidden>
        <path
            d="M 2 5 L 2 25 Q 12 30 22 25 L 22 5 Z"
            style={{
                fill: logservTheme.colors.tableHeaderBackground,
                stroke: logservTheme.colors.cyanAccent,
            }}
            strokeWidth="0.9"
        />
        <ellipse
            cx="12"
            cy="5"
            rx="10"
            ry="3.5"
            style={{
                fill: logservTheme.colors.cyanLight,
                stroke: logservTheme.colors.cyanAccent,
            }}
            strokeWidth="0.9"
        />
        <ellipse cx="12" cy="13" rx="10" ry="3.5" fill="none" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.6" opacity="0.55" />
        <ellipse cx="12" cy="20" rx="10" ry="3.5" fill="none" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.6" opacity="0.55" />
    </svg>
);

export default CylinderIcon;
