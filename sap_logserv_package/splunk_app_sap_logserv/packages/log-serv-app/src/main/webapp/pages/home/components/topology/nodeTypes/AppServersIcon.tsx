import React from 'react';
import { logservTheme } from '../../../styles/logservTheme';

/**
 * Inline SVG "rack stack" — a collection of SAP application servers.
 * Session-109 icon selection (Concept A of appserver_icon_concepts_preview
 * at the project root): three stacked horizontal server units, cyan-light
 * top unit echoing CylinderIcon's lid, LED dots + slot lines.
 *
 * Rendered inside SID discs for every NON-database SID (build 324, plan
 * §B4): DB-vendor-tagged SIDs keep CylinderIcon; tenants use
 * AppServersDbIcon (which composes this rack beside the cylinder).
 *
 * Colors via inline `style` (not SVG attributes) so the var(--lsv-*)
 * theme tokens resolve — the CylinderIcon build-246 convention.
 */
const AppServersIcon: React.FC<{ width?: number; height?: number }> = ({
    width = 32,
    height = 30,
}) => (
    <svg viewBox="0 0 32 30" width={width} height={height} aria-hidden>
        <rect x="3" y="2" width="26" height="7" rx="1.6" style={{ fill: logservTheme.colors.cyanLight, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <rect x="3" y="11.5" width="26" height="7" rx="1.6" style={{ fill: logservTheme.colors.tableHeaderBackground, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <rect x="3" y="21" width="26" height="7" rx="1.6" style={{ fill: logservTheme.colors.tableHeaderBackground, stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.9" />
        <line x1="6.5" y1="4.4" x2="12" y2="4.4" style={{ stroke: logservTheme.colors.panelBackground }} strokeWidth="1.1" opacity="0.9" />
        <line x1="6.5" y1="6.6" x2="10" y2="6.6" style={{ stroke: logservTheme.colors.panelBackground }} strokeWidth="1.1" opacity="0.9" />
        <line x1="6.5" y1="13.9" x2="12" y2="13.9" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.7" opacity="0.55" />
        <line x1="6.5" y1="16.1" x2="10" y2="16.1" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.7" opacity="0.55" />
        <line x1="6.5" y1="23.4" x2="12" y2="23.4" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.7" opacity="0.55" />
        <line x1="6.5" y1="25.6" x2="10" y2="25.6" style={{ stroke: logservTheme.colors.cyanAccent }} strokeWidth="0.7" opacity="0.55" />
        <circle cx="25" cy="5.5" r="1.3" style={{ fill: logservTheme.colors.panelBackground }} />
        <circle cx="25" cy="15" r="1.3" style={{ fill: logservTheme.colors.cyanLight }} />
        <circle cx="25" cy="24.5" r="1.3" style={{ fill: logservTheme.colors.cyanLight }} />
    </svg>
);

export default AppServersIcon;
