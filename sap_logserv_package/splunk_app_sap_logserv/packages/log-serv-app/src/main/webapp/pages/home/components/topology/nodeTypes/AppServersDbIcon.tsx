import React from 'react';
import { logservTheme } from '../../../styles/logservTheme';

/**
 * Inline SVG "app servers + database" — the rack stack (AppServersIcon
 * geometry, compacted to a 21 px column) beside the shipped database
 * cylinder (CylinderIcon geometry, scaled 0.78). Session-109 selection
 * ("A + cylinder", appserver_db_combo_icon_preview at the project root),
 * assigned to HANA TENANT nodes (build 324): a tenant is the application's
 * database side, so the app-tier + DB pairing represents it.
 *
 * Colors via inline `style` per the CylinderIcon build-246 convention.
 */
const AppServersDbIcon: React.FC<{ width?: number; height?: number }> = ({
    width = 44,
    height = 29,
}) => (
    <svg viewBox="0 0 46 30" width={width} height={height} aria-hidden>
        {/* rack stack (left column) */}
        <rect x="1" y="3" width="20" height="6.6" rx="1.5" style={{ fill: logservTheme.colors.cyanLight, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <rect x="1" y="11.7" width="20" height="6.6" rx="1.5" style={{ fill: logservTheme.colors.tableHeaderBackground, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <rect x="1" y="20.4" width="20" height="6.6" rx="1.5" style={{ fill: logservTheme.colors.tableHeaderBackground, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <line x1="3.6" y1="5.3" x2="8" y2="5.3" style={{ stroke: logservTheme.colors.panelBackground }} strokeWidth="1.0" opacity="0.9" />
        <line x1="3.6" y1="7.3" x2="6.6" y2="7.3" style={{ stroke: logservTheme.colors.panelBackground }} strokeWidth="1.0" opacity="0.9" />
        <line x1="3.6" y1="14" x2="8" y2="14" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.65" opacity="0.55" />
        <line x1="3.6" y1="16" x2="6.6" y2="16" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.65" opacity="0.55" />
        <line x1="3.6" y1="22.7" x2="8" y2="22.7" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.65" opacity="0.55" />
        <line x1="3.6" y1="24.7" x2="6.6" y2="24.7" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.65" opacity="0.55" />
        <circle cx="17.6" cy="6.3" r="1.15" style={{ fill: logservTheme.colors.panelBackground }} />
        <circle cx="17.6" cy="15" r="1.15" style={{ fill: logservTheme.colors.cyanLight }} />
        <circle cx="17.6" cy="23.7" r="1.15" style={{ fill: logservTheme.colors.cyanLight }} />
        {/* shipped cylinder (right column, CylinderIcon geometry at 0.78) */}
        <g transform="translate(26 1) scale(0.78)">
            <path d="M 2 5 L 2 25 Q 12 30 22 25 L 22 5 Z" style={{ fill: logservTheme.colors.tableHeaderBackground, stroke: logservTheme.colors.cyanAccent }} strokeWidth="1.1" />
            <ellipse cx="12" cy="5" rx="10" ry="3.5" style={{ fill: logservTheme.colors.cyanLight, stroke: logservTheme.colors.cyanAccent }} strokeWidth="1.1" />
            <ellipse cx="12" cy="13" rx="10" ry="3.5" fill="none" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.75" opacity="0.55" />
            <ellipse cx="12" cy="20" rx="10" ry="3.5" fill="none" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.75" opacity="0.55" />
        </g>
    </svg>
);

export default AppServersDbIcon;
