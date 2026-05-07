import React, { ReactNode, useEffect, useRef } from 'react';

/**
 * LegendTitleTooltips — wraps a Splunk chart and adds hover tooltips to
 * every legend item, set to the full label of that item. Handles both
 * legend rendering paths Splunk uses:
 *
 *   1) **Highcharts native SVG legend** — used for inline (top/bottom)
 *      legends. Each item is a `<g class="highcharts-legend-item …
 *      highcharts-series-N">` containing a `<text>` element. We add an
 *      SVG `<title>` child to each `<g>` (browsers render `<title>` as
 *      a native hover tooltip for SVG, equivalent to HTML `title=`).
 *
 *   2) **Splunk React side legend** — used for right-side legends with
 *      many series (e.g., the "Events Over Time by Host" chart). Each
 *      item is `<button data-test="legend-series-item">`. We set
 *      `title=` on the button.
 *
 * Why this exists: Splunk's `LegendSeriesItem` already wraps each
 * React-legend entry in a `StyledTooltip` whose content is set on
 * mouseenter — but the tooltip already missed its open window because
 * `content` was empty when the hover started. The Highcharts inline
 * legend has no tooltip support at all out of the box. Native SVG
 * `<title>` and HTML `title=` both fire reliably on every browser
 * without any React-state-timing involvement.
 *
 * Source of the full label:
 *   - Highcharts puts the un-truncated series name on `g.highcharts-series-N`
 *     as `aria-label`, formatted "Foo, bar series 1 of 2 with 31 bars."
 *     We strip the trailing ", <type> N of M with K …" suffix to get "Foo".
 *   - The legend item's class names include `highcharts-series-N` so we
 *     can match index-free.
 *
 * Per-instance MutationObserver because Splunk redraws the legend on
 * every dataSources change and Highcharts does its own resize-driven
 * relayout.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const HC_LEGEND_ITEM_SELECTOR = 'g.highcharts-legend-item';
const HC_SERIES_GROUP_SELECTOR = 'g.highcharts-series';
// React-legend selectors (from Splunk's @splunk/visualization-canvas Legends.js).
const REACT_LEGEND_BUTTON_SELECTOR = '[data-test="legend-series-item"]';
const REACT_LEGEND_LABEL_SELECTOR = '[data-test="legend-series-item-label"]';

/** Strip Highcharts' aria-label accessibility suffix.
 *  Live examples observed:
 *    "Windows High, bar series 1 of 2 with 31 bars."
 *    "Dispatcher, bar series 1 of 2 with 31 bars."
 *    "Foo, line 0 of 5 with 30 data points"
 *  All end with `, <one-or-two words> N of M …`. The regex grabs everything
 *  before that tail. Falls through to the raw string if nothing matches
 *  (better to show too much than nothing). */
const cleanAriaLabel = (raw: string | null | undefined): string => {
    if (!raw) return '';
    const m = raw.match(/^(.+?),\s+(?:\w+\s+){1,3}\d+\s+of\s+\d+/);
    return (m ? m[1] : raw).trim();
};

/** Extract `N` from a class like "… highcharts-series-3 …". */
const seriesIndexFromClass = (cls: string | null | undefined): number | null => {
    if (!cls) return null;
    // Match the FIRST highcharts-series-N occurrence — legend items also
    // include the series class so the same regex works for both.
    const m = cls.match(/(?:^|\s)highcharts-series-(\d+)(?:\s|$)/);
    return m ? parseInt(m[1], 10) : null;
};

/** Apply tooltips to Highcharts native SVG legend items. */
const applyHighchartsLegendTitles = (container: HTMLElement): void => {
    const legendItems = container.querySelectorAll<SVGGElement>(HC_LEGEND_ITEM_SELECTOR);
    legendItems.forEach((legendG) => {
        const cls = legendG.getAttribute('class');
        const idx = seriesIndexFromClass(cls);
        if (idx === null) return;
        const svg = legendG.closest('svg');
        if (!svg) return;

        // Find the series group with the SAME index in the same SVG. Use
        // a class-segment regex via querySelectorAll to avoid matching
        // the legend item itself (which also has the series-N class).
        const seriesGroups = Array.from(svg.querySelectorAll<SVGGElement>(HC_SERIES_GROUP_SELECTOR));
        const match = seriesGroups.find(
            (sg) => seriesIndexFromClass(sg.getAttribute('class')) === idx,
        );
        const fullLabel = cleanAriaLabel(match?.getAttribute('aria-label'));
        if (!fullLabel) return;

        // Reuse existing <title> if present, else create one as the first
        // child (SVG spec: <title> must be the first child to be usable
        // as a tooltip on the parent element by browsers).
        let titleEl = legendG.querySelector<SVGTitleElement>(':scope > title');
        if (!titleEl) {
            titleEl = document.createElementNS(SVG_NS, 'title');
            legendG.insertBefore(titleEl, legendG.firstChild);
        }
        if (titleEl.textContent !== fullLabel) titleEl.textContent = fullLabel;
    });
};

/** Apply tooltips to Splunk React side legend items. */
const applyReactLegendTitles = (container: HTMLElement): void => {
    const buttons = container.querySelectorAll<HTMLElement>(REACT_LEGEND_BUTTON_SELECTOR);
    if (buttons.length === 0) return;
    const seriesGroups = container.querySelectorAll<SVGGElement>(HC_SERIES_GROUP_SELECTOR);

    buttons.forEach((btn, idx) => {
        const fromAria = cleanAriaLabel(seriesGroups[idx]?.getAttribute('aria-label'));
        const labelSpan = btn.querySelector(REACT_LEGEND_LABEL_SELECTOR);
        const fromText = labelSpan?.textContent?.trim() || '';
        const title = fromAria || fromText;
        if (!title) return;
        if (btn.getAttribute('title') !== title) btn.setAttribute('title', title);
        if (labelSpan && labelSpan.getAttribute('title') !== title) {
            labelSpan.setAttribute('title', title);
        }
    });
};

const applyTitles = (container: HTMLElement): void => {
    applyHighchartsLegendTitles(container);
    applyReactLegendTitles(container);
};

interface Props {
    children: ReactNode;
}

const LegendTitleTooltips: React.FC<Props> = ({ children }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        // Re-entry guard so our own DOM writes don't infinite-loop the
        // MutationObserver.
        let applying = false;
        const apply = (): void => {
            if (applying) return;
            applying = true;
            try {
                applyTitles(container);
            } finally {
                applying = false;
            }
        };

        // Several initial passes — Splunk/Highcharts can take a beat to
        // render after data arrives, then again after layout settles.
        const initialTimers = [80, 250, 600, 1200].map((ms) =>
            window.setTimeout(apply, ms),
        );

        const observer = new MutationObserver(apply);
        observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label', 'transform'],
        });

        return () => {
            initialTimers.forEach((t) => window.clearTimeout(t));
            observer.disconnect();
        };
    }, []);

    return <div ref={containerRef}>{children}</div>;
};

export default LegendTitleTooltips;
