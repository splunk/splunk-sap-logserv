/**
 * LogServ "framed dark cards" theme — codified from the v0.0.4.2 dashboards.
 *
 * Used by the React shell's custom components (NavigationBar, AppShell,
 * PlaceholderDashboard, future panel chrome) to give the v0.0.5.0 React app
 * the same visual identity users already know from v0.0.4.2.
 *
 * Splunk's @splunk/react-ui components (Select, TimeRange dialog, Button popups)
 * still render via the prismaDark theme passed to @splunk/react-page; that is
 * intentional so they remain visually first-class Splunk components.
 */
export const logservTheme = {
    colors: {
        // Backgrounds
        pageBackground: '#0d1117',
        panelBackground: '#141b2d',
        navBackground: '#0d1117',

        // Borders
        panelBorder: '#0877a6', // cyan accent — outline of dashboard cards
        panelBorderWeak: '#2a3a52', // subtle separators

        // Text
        textActive: '#ffffff',
        textDefault: '#cdd9e5',
        textMuted: '#7b8ea8', // KPI labels, secondary copy

        // Status colors (use directly in panels and KPIs)
        red: '#dc4e41', // standard error
        redSevere: '#b50101',
        redLight: '#ff7a6b',
        orange: '#f1813f',
        orangeLight: '#f4a535',
        yellow: '#ffcc00',
        teal: '#00d4b4', // positive / success
        cyanAccent: '#0877a6',
        cyanLight: '#7ee8fa',
        purple: '#9c6aff',

        // Tables
        tableHeaderBackground: '#1e2a3d',
        tableRowOdd: '#0d1520',
        tableRowEven: 'transparent',

        // Interactive states
        hoverBackground: '#1e2a3d',
        activeAccent: '#0877a6',
    },
    spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        xxl: '32px',
    },
    fontSize: {
        small: '11px',
        body: '13px',
        large: '16px',
        xlarge: '20px',
        xxlarge: '28px',
        kpi: '36px',
    },
    fontWeight: {
        normal: 400,
        semibold: 600,
        bold: 700,
    },
    radius: {
        small: '3px',
        medium: '4px',
    },
    elevation: {
        panelOutline: '1px solid #0877a6',
        panelGap: '12px',
    },
} as const;

export type LogservTheme = typeof logservTheme;
