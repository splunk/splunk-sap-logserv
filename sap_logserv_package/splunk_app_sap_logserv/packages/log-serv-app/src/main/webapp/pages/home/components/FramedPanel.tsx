import React, { ReactNode, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { PanelMeta, PanelMetaContext, PanelDiagnosticContext, PanelActions } from './PanelMeta';
import { textFromNode } from '../utils/reactText';

/**
 * FramedPanel — the v0.0.4.2 "framed dark cards" container.
 *
 * Cyan-outlined dark fill with rounded corners, optional title and
 * inline-right action area. Foundation primitive for every dashboard panel.
 */

interface PanelRootProps {
    $compact?: boolean;
    /** When true, the panel is interactive — cursor: pointer + a hover
     *  state that brightens the border + lifts with a subtle shadow.
     *  Build 157 / session 027 task 4 — wires KPI / chart drilldowns. */
    $clickable?: boolean;
    /** When true, the panel stretches to 100% of its parent's height and
     *  the Body becomes a min-height:0 flex column so children can scroll
     *  internally instead of being clipped by an ancestor's
     *  overflow:hidden. Opt-in — used by the topology Live Activity panel
     *  (build 280); no effect on any other panel. */
    $fillHeight?: boolean;
}

const Root = styled.section<PanelRootProps>`
    /* Magnetic container-card (§6, build 254): surface bg, 1px border,
       4px radius, resting xs shadow. Hover (clickable) swaps the border to
       the interact accent and lifts to the md shadow — replaces the old
       cyan glow. Transitions at Magnetic's fast timing (150ms). */
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.medium};
    padding: ${(p) => (p.$compact ? logservTheme.spacing.md : logservTheme.spacing.lg)};
    color: ${logservTheme.colors.textActive};
    overflow: hidden;
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

    ${(p) =>
        p.$fillHeight
            ? `
        /* border-box is explicit: the app has no global box-sizing reset
         * (ambient default is content-box), and height:100% must mean the
         * BORDER box fills the parent — otherwise padding + borders push
         * the panel's bottom outline past the parent's overflow:hidden. */
        box-sizing: border-box;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
    `
            : ''}
`;

const Header = styled.header`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${logservTheme.spacing.sm};
    margin-bottom: ${logservTheme.spacing.md};
    /* Only meaningful when Root is a fillHeight flex column: keep the
     * header at its natural height so the Body absorbs all flexing. Inert
     * in the default block layout. */
    flex-shrink: 0;
`;

const Title = styled.h2`
    margin: 0;
    color: ${logservTheme.colors.textActive};
    /* Magnetic sub-section title: 14px semibold (§6, build 254). */
    font-size: 14px;
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Subtitle = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
`;

const Body = styled.div<{ $fill?: boolean }>`
    color: ${logservTheme.colors.textDefault};

    ${(p) =>
        p.$fill
            ? `
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
    `
            : ''}
`;

/** Right-side header cluster: any caller-supplied `actions` plus the build-234
 *  PanelActions toolbar, vertically centered (icons, not text baselines). */
const HeaderRight = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    align-self: center;
`;

interface FramedPanelProps {
    title?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    /** Build 234 — the panel's search result (from useSearch). When provided,
     *  FramedPanel renders the Open-in-Search / Download / Inspect / Refresh
     *  toolbar in the header. Tables pass this explicitly; charts report it
     *  automatically via PanelMetaContext (see usePanelMetaReporter), so chart
     *  panels need no prop. */
    search?: PanelMeta;
    /** Opt out of the action toolbar for a specific panel (e.g. non-data
     *  panels, or where the chrome would be redundant). */
    noToolbar?: boolean;
    compact?: boolean;
    /** Stretch the panel to fill its parent's height and let children
     *  manage their own internal scrolling (Body becomes a min-height:0
     *  flex column). See PanelRootProps.$fillHeight. */
    fillHeight?: boolean;
    children?: ReactNode;
    className?: string;
    /** Click handler — when set, the whole panel becomes interactive
     *  (cursor: pointer + hover state) and clicking anywhere in the panel
     *  fires the handler. Used for drilldowns. Clicks on interactive
     *  descendants (buttons, links, form controls, Highcharts chrome) and
     *  clicks synthesized at the end of a drag (chart zoom selection) do
     *  NOT fire the handler — see the guards in the click handler below.
     *  Build 157 / session 027 task 4; guards build 253. */
    onClick?: () => void;
    /** Tooltip / aria-label for the click affordance. Optional but
     *  strongly recommended when `onClick` is set. */
    clickTitle?: string;
}

const FramedPanel: React.FC<FramedPanelProps> = ({
    title,
    subtitle,
    actions,
    search,
    noToolbar,
    compact,
    fillHeight,
    children,
    className,
    onClick,
    clickTitle,
}) => {
    // Build 234 — capture search meta reported by an inner chart (charts run
    // their own useSearch); tables pass `search` explicitly. Either drives the
    // PanelActions toolbar.
    const [captured, setCaptured] = useState<PanelMeta | null>(null);
    const ctx = useMemo(() => ({ report: setCaptured }), []);
    /* Build 253 — pointer travel between pointerdown and click. A drag inside
     * the panel (chart zoom selection, text selection) ends with a browser-
     * synthesized click on the common ancestor of the down/up targets — this
     * panel — which must not count as a drilldown click. */
    const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
    const meta = search ?? captured;
    const showToolbar = !noToolbar && !!meta;
    /* Session 095 — the same explicit `search` the toolbar uses, plus the
     * panel's title, so the diagnosis drawer can name where it was opened from.
     * Memoised on the fields it actually reads: this value is handed to every
     * descendant through context, and a fresh object each render would re-render
     * every table body on the page for nothing.
     *
     * §14.6 (build 313): the title is extracted OUTSIDE the memo (a JSX title
     * ReactNode has a fresh identity every render — keying the memo on it
     * would mint a fresh context object each time), and a TITLE-ONLY context
     * is provided when there is no `search` prop: chart-owning panels feed
     * EmptyStateHint their facts directly, but the drawer/report previously
     * had no way to learn the panel's name from them ("(untitled)"). JSX
     * titles with text content are flattened via textFromNode. */
    const titleText = typeof title === 'string' ? title : textFromNode(title);
    const diagnosticValue = useMemo(
        () =>
            search
                ? { ...search, title: titleText }
                : titleText
                  ? { title: titleText }
                  : null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [search, titleText],
    );
    const headerRight =
        actions || showToolbar ? (
            <HeaderRight>
                {actions}
                {showToolbar && meta && <PanelActions meta={meta} title={typeof title === 'string' ? title : undefined} />}
            </HeaderRight>
        ) : null;
    const showHeader = title || subtitle || headerRight;
    const isClickable = !!onClick;
    return (
        <PanelMetaContext.Provider value={ctx}>
            {/* Session 093 — search metadata flowing DOWN, so an inner DataTable
                can explain its own empty state (it receives only
                rows/loading/error and cannot otherwise know which query
                produced it).

                Deliberately `search`, NOT `meta` (= `search ?? captured`):
                `captured` is reported UP by an inner CHART, so a panel holding
                both a chart and a table would hand the table the chart's SPL
                and it would explain itself using the wrong query. `captured`
                also never carries the diagnostic fields — `usePanelMetaReporter`
                reports only the four toolbar fields. Charts don't read this
                context at all; they pass their facts to EmptyStateHint
                directly. So the explicit `search` prop is the only trustworthy
                source here, and a panel without one correctly says nothing. */}
            <PanelDiagnosticContext.Provider value={diagnosticValue}>
            <Root
                $compact={compact}
                $clickable={isClickable}
                $fillHeight={fillHeight}
                className={className}
                onPointerDown={
                    isClickable
                        ? (e: React.PointerEvent) => {
                              pointerDownRef.current = { x: e.clientX, y: e.clientY };
                          }
                        : undefined
                }
                onClick={
                    isClickable
                        ? (e: React.MouseEvent) => {
                              /* Ignore clicks originating on interactive elements
                               * INSIDE the panel — they handle themselves and must
                               * not ALSO fire the drilldown (which opens a new tab
                               * on top of the control's own action). This guard
                               * must be GENERIC: @splunk/charting-bundle renders
                               * its zoom chrome (Reset Zoom / pan-left / pan-right)
                               * as plain HTML <button>s whose class names are
                               * build-hashed CSS-module strings (e.g.
                               * resetZoomButton_button-styles_<hash>) — a class
                               * allowlist can never match them (build-252 lesson;
                               * verified against the live control, build 253).
                               * The Root itself carries role="button" for a11y,
                               * hence the currentTarget exclusion. The
                               * .highcharts-* entries cover Highcharts' SVG chrome
                               * (legend items, SVG buttons, scrollbar), which are
                               * not HTML interactive elements. */
                              const t = e.target as Element | null;
                              if (t && typeof t.closest === 'function') {
                                  const interactive = t.closest(
                                      'button, a, input, select, textarea, label, summary, ' +
                                          '[role="button"], [role="link"], [role="menuitem"], ' +
                                          '[role="tab"], [role="option"], [role="checkbox"], [role="switch"], ' +
                                          '.highcharts-reset-zoom, .highcharts-button, ' +
                                          '.highcharts-legend, .highcharts-scrollbar',
                                  );
                                  if (interactive && interactive !== e.currentTarget) {
                                      return;
                                  }
                              }
                              /* Drag guard: pointer travel > 8px between
                               * pointerdown and click means a drag ended inside
                               * the panel, not a click on it. */
                              const down = pointerDownRef.current;
                              pointerDownRef.current = null;
                              if (down) {
                                  const dx = e.clientX - down.x;
                                  const dy = e.clientY - down.y;
                                  if (dx * dx + dy * dy > 64) {
                                      return;
                                  }
                              }
                              if (onClick) onClick();
                          }
                        : undefined
                }
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
                {showHeader && (
                    <Header>
                        <div>
                            {title && <Title>{title}</Title>}
                            {subtitle && <Subtitle>{subtitle}</Subtitle>}
                        </div>
                        {headerRight}
                    </Header>
                )}
                <Body $fill={fillHeight}>{children}</Body>
            </Root>
            </PanelDiagnosticContext.Provider>
        </PanelMetaContext.Provider>
    );
};

export default FramedPanel;
