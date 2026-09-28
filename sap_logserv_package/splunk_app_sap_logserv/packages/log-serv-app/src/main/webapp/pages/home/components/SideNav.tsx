import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import styled from 'styled-components';
import { dashboardsByCategory } from '../routes/dashboardRegistry';
import type { DashboardCategory, DashboardInfo } from '../routes/dashboardRegistry';
import { useIsAdmin } from '../hooks/useIsAdmin';
import { logservTheme } from '../styles/logservTheme';
import { readCachedNavCollapsed, writeCachedNavCollapsed } from '../state/navCollapsePersistence';
import NavDrawer, { DRAWER_VIEWPORT_MARGIN } from './NavDrawer';
import AboutModal from './AboutModal';

/**
 * The Magnetic left rail (Phase 7 / build 339 — plan
 * `cisco_magnetic_theme_plan_v0.2_20260920.md` §16).
 *
 * Replaces the four top-bar category dropdowns plus the two nav links. Q11
 * DELETED `components/NavCategoryDropdown.tsx` outright rather than leaving
 * it unused as a fallback, so there is no second navigation system to keep
 * in sync — and no file of that name to "swap back to". Recovery, if the
 * rail ever proves unusable narrow, is git history.
 *
 * Geometry is the ratified Q9 pair —
 * 244px expanded, 56px icon-only collapsed — carried from the preview along
 * with its 200ms width transition. Q13 (matching Splunk 10.5's native
 * 250/136) was considered and declined: 244 is within 6px of Splunk's
 * expanded width, and the 56px collapse buys back 188px, which is what
 * §16.4's content-width arithmetic needs.
 *
 * Contents are `routes/dashboardRegistry.ts` UNCHANGED — 23 dashboards in
 * 6 categories. The two singletons (Environment Health, Environment
 * Topology) are top-level rail items; the other 21 live in four flyout
 * sub-menus. Settings (admin-only) and About sit below a divider.
 *
 * LAYOUT CONTRACT with AppShell. The rail is a flex child of a `ShellBody`
 * that is `display: flex; position: relative`. It does NOT own a viewport
 * height: the page keeps its document scroll (Splunk Web's own chrome sits
 * above our React root and its height is not ours to assume), and the rail's
 * inner wrapper is `position: sticky; top: 0` so it stays reachable however
 * far the content scrolls.
 *
 * That inner wrapper deliberately has NO overflow property. The drawer is
 * absolutely positioned inside it at `left: 100%`, and `overflow-y: auto`
 * would compute `overflow-x` to `auto` as well and clip the flyout — the
 * session-025 lesson (an ancestor overflow beats any z-index). With nine
 * rail rows at ~40px the content cannot exceed a usable viewport anyway; if
 * it ever did, the document scroll is the fallback.
 */

const RAIL_W_EXPANDED = '244px';
const RAIL_W_COLLAPSED = '56px';

/** Below this the rail stops reserving width and floats over the content.
 *  Because Q11 removed the top-bar fallback, this is the only thing between
 *  a narrow window and an unusable app — so it is exercised, not assumed. */
const OVERLAY_BP = '860px';

/**
 * Routes where the rail defaults to COLLAPSED because the view needs the
 * width more than it needs the labels. Plan §16.4's first-preference
 * mitigation, chosen against a real build rather than on paper.
 *
 * MEASURED on sh-idxr at build 339, topology, 89 nodes, rail expanded — the
 * graph canvas is what absorbs the rail's width:
 *
 *     viewport   canvas (expanded)   canvas (collapsed)
 *       1920          974                  —
 *       1440          494                 682
 *       1280          334                  —
 *
 * Collapsing recovers exactly 188px (244 − 56). At 1920 the expanded rail is
 * comfortable; at 1280 a 334px canvas for an 89-node force graph is not.
 *
 * CORRECTION to plan §16.4, which offered "lowering the two topology
 * breakpoints" as the alternative mitigation: **topology has no breakpoints.**
 * `IntegrationTopology.tsx` and the whole `components/topology/` tree contain
 * zero `@media` rules, and nothing in the app references 1240px at all. The
 * zones are fixed-width, user-resizable and manually collapsible
 * (COLLAPSED_W = 26px), never automatic — so the canvas simply absorbs
 * whatever the rail leaves, at every width.
 *
 * This is a DEFAULT, not a lock: the toggle works normally here, and a
 * manual choice made on such a route is honoured for the visit without
 * overwriting the stored preference (see `override` below).
 */
const WIDTH_HUNGRY_ROUTES: readonly string[] = ['/topology/integration-topology'];

const Nav = styled.nav<{ $collapsed: boolean }>`
    flex: 0 0 auto;
    width: ${(p) => (p.$collapsed ? RAIL_W_COLLAPSED : RAIL_W_EXPANDED)};
    background: ${logservTheme.colors.navBackground};
    border-right: 1px solid ${logservTheme.colors.panelBorderWeak};
    transition: width 200ms ease;

    /* The rail must out-paint the routed content beside it, and the z-index
     * has to live HERE rather than on the flyout.
     *
     * Why: Sticky below is position:sticky, and sticky ALWAYS establishes a
     * stacking context — unlike relative/absolute, which only do so with a
     * non-auto z-index. So the drawer's own z-index is resolved INSIDE that
     * context, which itself sits at level 0; and because Main comes after
     * this element in DOM order, any positioned descendant of a dashboard
     * painted over the open flyout. Raising the whole rail subtree is the
     * fix; raising the flyout alone cannot work.
     *
     * 50 is chosen against the app's actual ladder: ordinary content uses
     * 1/10/30, every dropdown uses 1000-1100, modals 9000+, the portaled
     * node tooltip 10000. So the rail covers dashboards and is still covered
     * by anything the user deliberately opened on top of it. */
    position: relative;
    z-index: 50;

    @media (prefers-reduced-motion: reduce) {
        transition: none;
    }

    /* Narrow windows: leave the flex row entirely and float over the
     * content. ShellBody is the positioning context. The shadow marks the
     * rail as an overlay when it is expanded; collapsed it is a thin
     * icon strip that Main pads around (see AppShell). z-index is inherited
     * from the base rule above — one value, one place. */
    @media (max-width: ${OVERLAY_BP}) {
        position: absolute;
        top: 0;
        bottom: 0;
        box-shadow: ${(p) => (p.$collapsed ? 'none' : '0 8px 32px rgba(0, 0, 0, 0.28)')};
    }
`;

const Sticky = styled.div`
    position: sticky;
    top: 0;
    padding: ${logservTheme.spacing.md} ${logservTheme.spacing.sm};
    /* No overflow here — see the file header. */
`;

const TopRow = styled.div<{ $collapsed: boolean }>`
    display: flex;
    justify-content: ${(p) => (p.$collapsed ? 'center' : 'flex-end')};
    padding: ${(p) => (p.$collapsed ? '0 0 8px' : '0 4px 8px')};
`;

const ToggleButton = styled.button`
    width: 36px;
    height: 32px;
    border: none;
    border-radius: ${logservTheme.radius.medium};
    background: transparent;
    color: ${logservTheme.colors.textDefault};
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &:hover {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.textActive};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }

    svg {
        display: block;
    }
`;

const List = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${logservTheme.spacing.xs};
`;

const Extra = styled.li`
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

/* One shared visual for every rail row, whether it navigates (NavLink),
 * opens a flyout (button) or opens a dialog (button). `css` would let the
 * three share a block, but three thin styled() wrappers over one base keeps
 * each element semantically correct without duplicating the declarations. */
const rowStyles = `
    /* MANDATORY with width:100% + padding. This app has no global border-box
     * reset, so a content-box row computed 100% of the rail's 228px content
     * area and then ADDED its 24px of padding — a 252px row inside a 245px
     * rail. That is what made the active highlight look "too wide": it was
     * literally wider than the rail it sits in, and ran past the border. */
    box-sizing: border-box;
    width: 100%;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 10px;
    border: none;
    background: transparent;
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
`;

const RowLink = styled(NavLink)<{ $collapsed: boolean }>`
    ${rowStyles}
    padding: ${(p) => (p.$collapsed ? '10px 4px' : '10px 12px')};
    justify-content: ${(p) => (p.$collapsed ? 'center' : 'flex-start')};
    gap: ${(p) => (p.$collapsed ? '0' : '10px')};
    border-radius: ${logservTheme.radius.medium};
    color: ${logservTheme.colors.textDefault};
    font-size: ${logservTheme.fontSize.body};

    &:hover {
        color: ${logservTheme.colors.textActive};
        background: ${logservTheme.colors.hoverBackground};
    }

    &.active {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.textActive};
        /* The OneCD teal, kept through the Phase 6 scaffold swap precisely
         * for nav-active (plan Q8). Inset so it reads as a rail marker
         * rather than a border. */
        box-shadow: inset 3px 0 0 ${logservTheme.colors.navAccent};
        font-weight: ${logservTheme.fontWeight.semibold};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }
`;

const RowButton = styled.button<{ $collapsed: boolean; $active: boolean }>`
    ${rowStyles}
    padding: ${(p) => (p.$collapsed ? '10px 4px' : '10px 12px')};
    justify-content: ${(p) => (p.$collapsed ? 'center' : 'flex-start')};
    gap: ${(p) => (p.$collapsed ? '0' : '10px')};
    border-radius: ${logservTheme.radius.medium};
    font-size: ${logservTheme.fontSize.body};
    color: ${(p) =>
        p.$active ? logservTheme.colors.textActive : logservTheme.colors.textDefault};
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    box-shadow: ${(p) =>
        p.$active ? `inset 3px 0 0 ${logservTheme.colors.navAccent}` : 'none'};
    font-weight: ${(p) =>
        p.$active ? logservTheme.fontWeight.semibold : logservTheme.fontWeight.normal};

    &:hover {
        color: ${logservTheme.colors.textActive};
        background: ${logservTheme.colors.hoverBackground};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }
`;

const Icon = styled.span`
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    svg {
        display: block;
    }
`;

const RowLabel = styled.span<{ $collapsed: boolean }>`
    display: ${(p) => (p.$collapsed ? 'none' : 'block')};
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

/* Points RIGHT, at the flyout it opens. A down-chevron would be the
 * accordion's indicator, and Harbor's sub-menu is not an accordion. */
const Chevron = styled.svg<{ $collapsed: boolean; $open: boolean }>`
    display: ${(p) => (p.$collapsed ? 'none' : 'block')};
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    opacity: ${(p) => (p.$open ? 1 : 0.75)};
    transform: rotate(-90deg);
    transition: opacity 180ms ease;
`;

/* ------------------------------------------------------------------ *
 * Icons — carried from the preview's sprite, inlined per component so
 * the rail has no dependency on a document-level <symbol> sheet.
 * ------------------------------------------------------------------ */

type IconProps = { size?: number };

const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
};

const MenuIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden>
        <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
);

const PulseIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M3 12h4l2-6 4 12 2-6h6" />
        <circle cx="12" cy="12" r="9" opacity="0.25" />
    </svg>
);

const FlowIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <circle cx="5" cy="5" r="2.5" />
        <circle cx="19" cy="5" r="2.5" />
        <circle cx="12" cy="14" r="2.5" />
        <circle cx="5" cy="20" r="2" />
        <circle cx="19" cy="20" r="2" />
        <path d="M5 7.5v3a3 3 0 0 0 3 3h1.5M19 7.5v3a3 3 0 0 1-3 3h-1.5M12 16.5v1.5" />
    </svg>
);

const GridIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
);

const PlugIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <g transform="rotate(-45 12 12)">
            <path d="M8 7.8a4.2 4.2 0 0 0 0 8.4z" />
            <path d="M16 7.8a4.2 4.2 0 0 1 0 8.4z" />
            <path d="M8 9.8h8M8 14.2h8" />
        </g>
    </svg>
);

const ShieldIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />
        <path d="m9 12 2 2 4-4" />
    </svg>
);

const TreeIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="9" y="15" width="6" height="6" rx="1" />
        <path d="M6 9v3h12V9M12 12v3" />
    </svg>
);

const GearIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
);

const BookIcon: React.FC<IconProps> = ({ size = 20 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
        <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v16H5.5A1.5 1.5 0 0 0 4 20.5z" />
        <path d="M4 20.5A1.5 1.5 0 0 1 5.5 19H19v2H5.5A1.5 1.5 0 0 1 4 20.5z" />
        <path d="M8 7h7M8 11h7" />
    </svg>
);

const ChevronPath: React.FC = () => <path d="m6 9 6 6 6-6" />;

/* ------------------------------------------------------------------ */

interface CategoryDef {
    key: DashboardCategory;
    label: string;
    icon: React.FC<IconProps>;
}

/** The four flyout categories, in the order the top bar used. */
const CATEGORIES: CategoryDef[] = [
    { key: 'applications', label: 'Applications', icon: GridIcon },
    { key: 'integration', label: 'Integration', icon: PlugIcon },
    { key: 'security', label: 'Security', icon: ShieldIcon },
    { key: 'platform', label: 'Platform', icon: TreeIcon },
];

/**
 * Harbor's `isDescendantSelected()` — is the current route one of this
 * category's dashboards?
 *
 * Derived from the REGISTRY, not from a path prefix. That is a deliberate
 * fix, not an incidental difference: `/diagnostics` is a `platform`
 * dashboard whose path does not begin with `/platform/`, so the old
 * dropdown's `startsWith('/platform/')` trigger never lit for it — a
 * cosmetic defect the registry itself documents at its `diagnostics`
 * entry. Matching on membership makes that case correct for free, and
 * cannot drift when a future dashboard is added off-pattern.
 */
const categoryOwnsPath = (key: DashboardCategory, pathname: string): boolean =>
    dashboardsByCategory[key].some((d) => d.path === pathname);

const SideNav: React.FC = () => {
    const location = useLocation();
    const { isAdmin } = useIsAdmin();

    /** The user's stored preference. Persisted. */
    const [collapsed, setCollapsed] = React.useState<boolean>(() => readCachedNavCollapsed());
    /** Which category's flyout is open — Harbor opens exactly one. */
    const [openCategory, setOpenCategory] = React.useState<DashboardCategory | null>(null);
    /** Where that flyout sits vertically, in px from the sticky wrapper's top.
     *  Measured on open by the layout effect below. */
    const [drawerTop, setDrawerTop] = React.useState<number>(0);
    const [aboutOpen, setAboutOpen] = React.useState<boolean>(false);

    const drawerRef = React.useRef<HTMLDivElement | null>(null);
    /** The flyout's offset parent — `Sticky` is `position: sticky`, which is a
     *  positioned value, so absolute offsets inside it resolve against this. */
    const stickyRef = React.useRef<HTMLDivElement | null>(null);
    /** The four category buttons, so the flyout can be aligned with whichever
     *  one opened it. */
    const categoryRefs = React.useRef<Partial<Record<DashboardCategory, HTMLButtonElement | null>>>(
        {},
    );

    const routeWantsCollapse = WIDTH_HUNGRY_ROUTES.includes(location.pathname);

    /** A per-visit answer that outranks both the preference and the route
     *  default, set only when the user works the toggle on a width-hungry
     *  route. `null` means "nobody has overridden anything here". */
    const [override, setOverride] = React.useState<boolean | null>(null);

    /* Any navigation ends the override's scope — it is per visit, so arriving
     * anywhere (including back onto the same width-hungry route) starts from
     * the preference and the route default again. */
    React.useEffect(() => {
        setOverride(null);
    }, [location.pathname]);

    const effectiveCollapsed = override ?? (routeWantsCollapse ? true : collapsed);

    const toggleCollapsed = React.useCallback((): void => {
        const next = !effectiveCollapsed;
        if (routeWantsCollapse) {
            /* Deliberately does NOT persist. Expanding the rail to read a
             * label on the topology page is a momentary act, and letting it
             * rewrite the global preference would mean one visit here
             * silently changed how every other dashboard opens. */
            setOverride(next);
        } else {
            setOverride(null);
            setCollapsed(next);
            writeCachedNavCollapsed(next);
        }
    }, [effectiveCollapsed, routeWantsCollapse]);

    const closeDrawer = React.useCallback((): void => setOpenCategory(null), []);

    /* A route CHANGE dismisses the flyout.
     *
     * This is one of two paths that close it on navigation, and it is the one
     * that needs no click at all — browser back/forward, or anything that
     * routes programmatically. The other is the outside-click handler below.
     *
     * On its own this is NOT sufficient, which was measured rather than
     * assumed: clicking Environment Health while already on Environment
     * Health changes no pathname, so this effect never fires, and on build
     * 348 the flyout stayed open in exactly that case. Same reason a flyout
     * row carries its own onNavigate. Do not delete the other path on the
     * grounds that this one looks like it covers everything. */
    React.useEffect(() => {
        setOpenCategory(null);
    }, [location.pathname]);

    const toggleCategory = React.useCallback((key: DashboardCategory): void => {
        setOpenCategory((prev) => (prev === key ? null : key));
    }, []);

    /* Line the flyout up with the row that opened it.
     *
     * MEASURED, not computed from constants: the row height, the flyout's
     * header and its body padding are all CSS, and a second copy of them here
     * would drift the first time any of them is tuned. useLayoutEffect runs
     * before paint, so the offset lands in the same frame as the open and
     * there is no visible jump from the previous position.
     *
     * The clamp keeps a tall category on screen at a short viewport — Platform
     * has 8 rows, and its row sits low in the rail. It is computed at open
     * time only: a resize while the flyout is open can leave it stale, which
     * is accepted because the flyout is transient (any click outside, Escape
     * or a navigation closes it) and Wrap's own max-height already stops it
     * exceeding the viewport height. */
    React.useLayoutEffect(() => {
        if (!openCategory) return;
        const btn = categoryRefs.current[openCategory];
        const sticky = stickyRef.current;
        const wrap = drawerRef.current;
        if (!btn || !sticky || !wrap) return;
        const stickyTop = sticky.getBoundingClientRect().top;
        const desired = btn.getBoundingClientRect().top - stickyTop;
        const room = window.innerHeight - DRAWER_VIEWPORT_MARGIN - wrap.offsetHeight - stickyTop;
        setDrawerTop(Math.max(0, Math.min(desired, room)));
    }, [openCategory, effectiveCollapsed]);

    /* Click-elsewhere + Escape dismiss the flyout.
     *
     * The handler asks "was this on something that handles the click itself?"
     * rather than having those elements stopPropagation. stopPropagation on an
     * overlay's own trigger blinds every OTHER overlay's outside-click
     * handler, which is how two panels end up open at once (session 128
     * defect 2) — the ActionsDropdown and the palette picker in the preview
     * both listen at the document.
     *
     * Only TWO things are exempt, and the narrowness is the point. Until
     * session 131 this bailed on a click anywhere inside the rail, which is
     * much wider than the purpose needs: it meant the rail's own top-level
     * rows navigated with the previous category's sub-menu left open behind
     * them, still lit, describing a category the user had just left. Those
     * rows shipped in build 339 with no close handler and went unnoticed for
     * nine builds — which is why this closes by default and exempts by
     * exception, so a row added later is covered without anyone remembering
     * to wire it. */
    React.useEffect(() => {
        if (!openCategory) return undefined;
        const onDocClick = (e: MouseEvent): void => {
            const t = e.target as Node | null;
            if (!t) return;
            /* The flyout itself: its rows close it via onNavigate and its
             * header's × via onClose. */
            if (drawerRef.current && drawerRef.current.contains(t)) return;
            /* A category button toggles. Without this the click that OPENS a
             * flyout would immediately close it again. */
            const onCategoryButton = CATEGORIES.some((c) => {
                const el = categoryRefs.current[c.key];
                return el != null && el.contains(t);
            });
            if (onCategoryButton) return;
            setOpenCategory(null);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpenCategory(null);
        };
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [openCategory]);

    const openDef = CATEGORIES.find((c) => c.key === openCategory);
    const drawerItems: DashboardInfo[] = openCategory ? dashboardsByCategory[openCategory] : [];

    return (
        <>
            <Nav $collapsed={effectiveCollapsed} aria-label="Primary">
                <Sticky ref={stickyRef}>
                    <TopRow $collapsed={effectiveCollapsed}>
                        <ToggleButton
                            type="button"
                            onClick={toggleCollapsed}
                            aria-label={effectiveCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                            aria-expanded={!effectiveCollapsed}
                            title={effectiveCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                        >
                            <MenuIcon />
                        </ToggleButton>
                    </TopRow>

                    <List>
                        {/* The two singleton dashboards are top-level rail rows —
                            one click, no flyout. */}
                        <li>
                            <RowLink to="/" end $collapsed={effectiveCollapsed} title="Environment Health">
                                <Icon>
                                    <PulseIcon />
                                </Icon>
                                <RowLabel $collapsed={effectiveCollapsed}>Environment Health</RowLabel>
                            </RowLink>
                        </li>
                        <li>
                            <RowLink
                                to="/topology/integration-topology"
                                $collapsed={effectiveCollapsed}
                                title="Environment Topology"
                            >
                                <Icon>
                                    <FlowIcon />
                                </Icon>
                                <RowLabel $collapsed={effectiveCollapsed}>Topology</RowLabel>
                            </RowLink>
                        </li>

                        {CATEGORIES.map(({ key, label, icon: CatIcon }) => {
                            const isOpen = openCategory === key;
                            return (
                                <li key={key}>
                                    <RowButton
                                        type="button"
                                        ref={(el) => {
                                            categoryRefs.current[key] = el;
                                        }}
                                        $collapsed={effectiveCollapsed}
                                        /* Lit while its flyout is open OR while one of
                                           its dashboards is the current route. */
                                        $active={isOpen || categoryOwnsPath(key, location.pathname)}
                                        aria-expanded={isOpen}
                                        aria-haspopup="menu"
                                        title={label}
                                        onClick={() => toggleCategory(key)}
                                    >
                                        <Icon>
                                            <CatIcon />
                                        </Icon>
                                        <RowLabel $collapsed={effectiveCollapsed}>{label}</RowLabel>
                                        <Chevron
                                            $collapsed={effectiveCollapsed}
                                            $open={isOpen}
                                            viewBox="0 0 24 24"
                                            {...stroke}
                                            aria-hidden
                                        >
                                            <ChevronPath />
                                        </Chevron>
                                    </RowButton>
                                </li>
                            );
                        })}

                        {/* Utility group below a divider. The divider belongs to
                            whichever row comes FIRST, so a non-admin (no
                            Settings) still gets it above About rather than
                            losing it — hence `Divided` on index 0 rather than a
                            hardcoded element. */}
                        {[
                            /* Settings is admin-gated exactly as the old top-bar
                               link was: the REST endpoints behind the page are
                               gated server-side too, so this is UX, not the
                               security boundary. */
                            isAdmin ? (
                                <RowLink
                                    key="settings"
                                    to="/settings"
                                    $collapsed={effectiveCollapsed}
                                    title="Application Settings"
                                >
                                    <Icon>
                                        <GearIcon />
                                    </Icon>
                                    <RowLabel $collapsed={effectiveCollapsed}>Settings</RowLabel>
                                </RowLink>
                            ) : null,
                            /* About opens a dialog rather than navigating, so it
                               is a button with no active state — there is no
                               route to be "on". */
                            <RowButton
                                key="about"
                                type="button"
                                $collapsed={effectiveCollapsed}
                                $active={false}
                                aria-haspopup="dialog"
                                aria-expanded={aboutOpen}
                                title="Version and build information"
                                /* About opens a modal rather than navigating,
                                   so the route-keyed effect above cannot see
                                   it — close the flyout explicitly. */
                                onClick={() => {
                                    closeDrawer();
                                    setAboutOpen(true);
                                }}
                            >
                                <Icon>
                                    <BookIcon />
                                </Icon>
                                <RowLabel $collapsed={effectiveCollapsed}>About</RowLabel>
                            </RowButton>,
                        ]
                            .filter((el): el is React.ReactElement => el !== null)
                            .map((el, i) =>
                                i === 0 ? (
                                    <Extra key={el.key}>{el}</Extra>
                                ) : (
                                    <li key={el.key}>{el}</li>
                                ),
                            )}
                    </List>

                    {/* ONE drawer, repopulated per category — hbr-shell-nav opens
                        one at a time. Kept mounted so the close transition is
                        visible; `visibility: hidden` keeps it out of the tab
                        order while closed. */}
                    <NavDrawer
                        innerRef={drawerRef}
                        open={openCategory !== null}
                        top={drawerTop}
                        title={openDef ? openDef.label : ''}
                        items={drawerItems}
                        onClose={closeDrawer}
                        onNavigate={closeDrawer}
                    />
                </Sticky>
            </Nav>

            <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
        </>
    );
};

export default SideNav;

/** The rail's two widths and the breakpoint at which it stops reserving
 *  space. Exported because AppShell's `Main` has to pad around the rail once
 *  it overlays, and that padding must not be a second hand-typed copy of
 *  56px. Keeping all three in one place also means a future geometry change
 *  — Q13, or a Splunk release that puts its own rail beside ours — is a
 *  value edit in a single file. */
export const RAIL_GEOMETRY = {
    expanded: RAIL_W_EXPANDED,
    collapsed: RAIL_W_COLLAPSED,
    overlayBreakpoint: OVERLAY_BP,
} as const;
