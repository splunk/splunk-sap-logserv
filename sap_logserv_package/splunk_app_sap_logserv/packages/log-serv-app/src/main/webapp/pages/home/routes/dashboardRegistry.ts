export type DashboardCategory =
    | 'home'
    | 'topology'
    | 'applications'
    | 'integration'
    | 'security'
    | 'platform';

export interface DashboardInfo {
    slug: string;
    name: string;
    category: DashboardCategory;
    path: string;
}

/**
 * The 21 LogServ dashboards, organized into 4 navigation categories
 * plus one default-landing entry (Environment Health).
 *
 * Each entry is a route in the React SPA. Phase 0 ships them as
 * placeholders; subsequent phases replace each with the real dashboard.
 */
export const dashboards: DashboardInfo[] = [
    { slug: 'environment-health', name: 'Environment Health', category: 'home', path: '/' },

    { slug: 'integration-topology', name: 'Environment Topology', category: 'topology', path: '/topology/integration-topology' },

    { slug: 'abap-security', name: 'ABAP Network & Security', category: 'applications', path: '/applications/abap-security' },
    { slug: 'abap-operations', name: 'ABAP Operations', category: 'applications', path: '/applications/abap-operations' },
    { slug: 'work-process-performance', name: 'Work Process Performance', category: 'applications', path: '/applications/work-process-performance' },
    { slug: 'hana-audit', name: 'HANA Audit', category: 'applications', path: '/applications/hana-audit' },
    { slug: 'hana-trace', name: 'HANA Trace', category: 'applications', path: '/applications/hana-trace' },

    { slug: 'sap-services', name: 'SAP Services', category: 'integration', path: '/integration/sap-services' },
    { slug: 'sap-router', name: 'SAP Router', category: 'integration', path: '/integration/sap-router' },
    { slug: 'cloud-connector', name: 'Cloud Connector', category: 'integration', path: '/integration/cloud-connector' },
    { slug: 'web-dispatcher', name: 'Web Dispatcher', category: 'integration', path: '/integration/web-dispatcher' },
    { slug: 'web-api-performance', name: 'Web and API Performance', category: 'integration', path: '/integration/web-api-performance' },

    { slug: 'network-perimeter', name: 'Network Perimeter', category: 'security', path: '/security/network-perimeter' },
    { slug: 'cross-stack-authentication', name: 'Cross-Stack Authentication', category: 'security', path: '/security/cross-stack-authentication' },
    { slug: 'change-config', name: 'Change & Configuration Activity', category: 'security', path: '/security/change-config' },

    { slug: 'data-pipeline-overview', name: 'Data Pipeline Overview', category: 'platform', path: '/platform/data-pipeline-overview' },
    { slug: 'dns-analytics', name: 'DNS Analytics', category: 'platform', path: '/platform/dns-analytics' },
    { slug: 'linux', name: 'Linux', category: 'platform', path: '/platform/linux' },
    { slug: 'windows', name: 'Windows', category: 'platform', path: '/platform/windows' },
    { slug: 'proxy', name: 'Proxy', category: 'platform', path: '/platform/proxy' },
    { slug: 'host-details', name: 'Host Details', category: 'platform', path: '/platform/host-details' },
    { slug: 'multi-cloud-overview', name: 'Multi-Cloud Overview', category: 'platform', path: '/platform/multi-cloud-overview' },
];

export const dashboardsByCategory: Record<DashboardCategory, DashboardInfo[]> = {
    home: dashboards.filter((d) => d.category === 'home'),
    topology: dashboards.filter((d) => d.category === 'topology'),
    applications: dashboards.filter((d) => d.category === 'applications'),
    integration: dashboards.filter((d) => d.category === 'integration'),
    security: dashboards.filter((d) => d.category === 'security'),
    platform: dashboards.filter((d) => d.category === 'platform'),
};

export const findDashboardByPath = (pathname: string): DashboardInfo | undefined =>
    dashboards.find((d) => d.path === pathname);
