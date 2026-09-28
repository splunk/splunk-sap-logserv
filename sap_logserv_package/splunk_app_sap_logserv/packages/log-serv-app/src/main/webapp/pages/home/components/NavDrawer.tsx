import React from 'react';
import { NavLink } from 'react-router-dom';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import type { DashboardInfo } from '../routes/dashboardRegistry';

/**
 * The left rail's sub-menu — Harbor's FLYOUT DRAWER, not an accordion.
 *
 * Established in session 128 by reading the Cisco boilerplate's own
 * `src/components/shell/nav.jsx`: a `submenu` node is an `<hbr-nav-item>`
 * carrying `slot="drawerHeader"` + `slot="menu"`, its children are
 * `<hbr-menu-item nav>` rows, the current row takes `checked` AND
 * `checkMark` — a CHECK MARK, not a highlight bar — and
 * `isDescendantSelected()` keeps the PARENT rail item lit. One drawer is
 * open at a time and it opens whether the rail is expanded or collapsed,
 * which is what Harbor's `--drawer-left` / `--drawer-collapsed-left` pair
 * exists for.
 *
 * Harbor's published docs are usage-only, so the three chrome decisions
 * here — the 264px width, the 160ms slide and the close button — are the
 * preview's own inventions on top of a specified structure. Saying so is
 * deliberate: a future reader should be able to tell which parts are
 * Harbor's contract and which are ours.
 *
 * POSITIONING, HORIZONTAL. This renders INSIDE the rail's sticky inner
 * wrapper and is offset with `left: 100%`, so it tracks the rail's right
 * edge at either width with no second copy of the width value, and it
 * travels with the rail when the document scrolls. That inner wrapper
 * therefore must not establish an overflow clip — see the note in
 * SideNav.tsx.
 *
 * POSITIONING, VERTICAL — and this part is OURS, not Harbor's. Harbor's nav
 * exposes `--drawer-left`, `--drawer-collapsed-left` and a single global
 * `--header-offset`: horizontal placement plus one top offset, with no
 * per-item vertical alignment. Build 339 followed that and pinned the flyout
 * to the top of the rail, which reads as unrelated to the row you clicked.
 * `$top` is supplied by SideNav, which measures the opening row. Saying which
 * half is Harbor's contract and which is a product decision is deliberate, so
 * that a later reader comparing us against Harbor does not "fix" this back.
 *
 * Phase 7 / build 339 — plan §16.3. Vertical alignment: session 131.
 */

/** Breathing room kept between the flyout and the bottom of the viewport.
 *  Exported because SideNav's clamp has to respect the same figure, and a
 *  second hand-typed copy of it would drift the moment either is tuned. */
export const DRAWER_VIEWPORT_MARGIN = 24;

const Wrap = styled.div<{ $open: boolean; $top: number }>`
    box-sizing: border-box;
    position: absolute;
    /* Aligned with the rail row that opened this — see the POSITIONING notes
     * in the file header. SideNav measures and clamps; this just renders it. */
    top: ${(p) => p.$top}px;
    left: 100%;
    z-index: 45;
    width: 264px;
    max-height: calc(100vh - ${DRAWER_VIEWPORT_MARGIN}px);
    display: flex;
    flex-direction: column;
    background: ${logservTheme.colors.navBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.medium};
    box-shadow: 6px 0 22px rgba(0, 0, 0, 0.18);

    /* Closed state animates OUT and then goes visibility:hidden, so a closed
     * drawer is not a focus trap for keyboard/AT users. Delaying the
     * visibility step by the transition duration is what makes the fade
     * visible at all — and it is also why a synchronous getComputedStyle
     * read taken right after a toggle lies about this element (session 128
     * defect 3). Settle past 160ms before measuring.
     * (No backticks — styled-components template literal.) */
    transform: ${(p) => (p.$open ? 'translateX(0)' : 'translateX(-10px)')};
    opacity: ${(p) => (p.$open ? 1 : 0)};
    visibility: ${(p) => (p.$open ? 'visible' : 'hidden')};
    transition: transform 160ms ease-out, opacity 160ms ease-out,
        visibility 0s linear ${(p) => (p.$open ? '0s' : '160ms')};

    @media (prefers-reduced-motion: reduce) {
        transition: none;
    }
`;

/* Harbor's drawerHeader slot. */
const Head = styled.div`
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    padding: 10px ${logservTheme.spacing.sm} 10px ${logservTheme.spacing.lg};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    color: ${logservTheme.colors.textActive};
`;

const CloseButton = styled.button`
    margin-left: auto;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: ${logservTheme.radius.medium};
    background: transparent;
    color: ${logservTheme.colors.textMuted};
    font: inherit;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;

    &:hover {
        color: ${logservTheme.colors.textActive};
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.panelBorder};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }
`;

/* Harbor's menu slot. */
const Body = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* Explicit. Setting only overflow-y computes overflow-x to auto as well,
     * which is precisely how a horizontal scrollbar appeared under the
     * sub-menu: the rows overflowed (see Row's box-sizing note) and the
     * body dutifully offered to scroll sideways. With border-box rows the
     * overflow is gone, and this makes a long label ellipsis instead of
     * ever reintroducing it. (No backticks — styled-components literal.) */
    overflow-x: hidden;
    padding: ${logservTheme.spacing.sm};
`;

const Row = styled(NavLink)`
    /* See the rail's rowStyles: no global border-box reset in this app, so
     * width:100% + padding overflowed the drawer body by exactly the
     * padding (268px rows in a 264px body) and produced a horizontal
     * scrollbar. */
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.sm} 10px;
    border: none;
    border-radius: ${logservTheme.radius.medium};
    background: transparent;
    color: ${logservTheme.colors.textDefault};
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    text-decoration: none;
    cursor: pointer;

    &:hover {
        color: ${logservTheme.colors.textActive};
        background: ${logservTheme.colors.hoverBackground};
    }

    &.active {
        color: ${logservTheme.colors.textActive};
        font-weight: ${logservTheme.fontWeight.semibold};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: -2px;
    }
`;

/* `checkMark` — reserves its width unconditionally so rows do not shift
 * horizontally as the selection moves between them. */
const Check = styled.span`
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    color: ${logservTheme.colors.navAccent};
    font-weight: ${logservTheme.fontWeight.bold};
    visibility: hidden;

    ${Row}.active & {
        visibility: visible;
    }
`;

/* The label gets its OWN element rather than being the row's bare text.
 * The check mark is a sibling, so the row's textContent is "✓Web Dispatcher"
 * — in the preview a router keyed on that string went silently inert
 * (session 128 defect 1). Nothing here reads textContent (React routes on
 * `d.path`), but the structure that made the bug possible is the same one,
 * so the label stays addressable on its own. */
const Label = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

export interface NavDrawerProps {
    /** Whether the flyout is showing. */
    open: boolean;
    /** Offset in px from the top of the rail's sticky wrapper, so the flyout
     *  lines up with the row that opened it. Measured and clamped by the
     *  consumer — see SideNav's layout effect. */
    top: number;
    /** Category label, rendered in the drawerHeader slot. */
    title: string;
    /** The category's dashboards, in registry order. */
    items: DashboardInfo[];
    /** Close without navigating (the × button). */
    onClose: () => void;
    /** A row was chosen — the consumer closes the drawer. */
    onNavigate: () => void;
    /** Forwarded so the consumer's outside-click handler can ask
     *  "was this click inside the drawer?" rather than having the drawer
     *  stopPropagation — which would blind every OTHER overlay's
     *  outside-click handler and leave two panels open at once
     *  (session 128 defect 2). */
    innerRef?: React.Ref<HTMLDivElement>;
}

const NavDrawer: React.FC<NavDrawerProps> = ({
    open,
    top,
    title,
    items,
    onClose,
    onNavigate,
    innerRef,
}) => (
    <Wrap
        ref={innerRef}
        $open={open}
        $top={top}
        role="dialog"
        aria-modal="false"
        aria-hidden={!open}
        aria-label={title}
    >
        <Head>
            <span>{title}</span>
            <CloseButton type="button" onClick={onClose} title="Close" aria-label="Close sub-menu">
                ×
            </CloseButton>
        </Head>
        <Body role="menu" aria-label={title}>
            {items.map((d) => (
                <Row
                    key={d.slug}
                    to={d.path}
                    end
                    role="menuitem"
                    /* A closed drawer is inert to the keyboard: `visibility:
                     * hidden` already removes it from the tab order, and this
                     * keeps that true for anything that walks links directly. */
                    tabIndex={open ? 0 : -1}
                    onClick={onNavigate}
                >
                    <Check aria-hidden>✓</Check>
                    <Label>{d.name}</Label>
                </Row>
            ))}
        </Body>
    </Wrap>
);

export default NavDrawer;
