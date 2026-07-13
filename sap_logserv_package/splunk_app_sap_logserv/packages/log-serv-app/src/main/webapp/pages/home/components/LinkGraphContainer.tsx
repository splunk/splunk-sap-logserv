import styled from 'styled-components';
import type { ThemeMode } from '../styles/magneticTokens';

/**
 * LinkGraphContainer — shared shell around Splunk's LinkGraph viz, used by
 * the two "Source to sourcetype mapping" panels (Data Pipeline Overview →
 * Sourcetype Mapping tab, Host Details → Tab 3). Extracted from the two
 * dashboards' identical local copies in build 281 so the node restyle
 * below has a single source of truth.
 *
 * Job 1 — scrollbar suppression (pre-existing): Splunk renders an
 * `overflow: auto` div around its 3-column body; even with this outer
 * container using `overflow-x: hidden`, that inner element still draws its
 * own scrollbar. Cascading `overflow-x: hidden !important` to every
 * descendant kills it while leaving vertical scrolling intact.
 *
 * Job 2 — node restyle (build 281 / session 081, user request): the
 * LinkGraph draws its node bars as HTML `<button class="node">` elements
 * (NOT SVG — GradientWrap can't touch them). Their colors are hardcoded in
 * the viz's own generated CSS: `.<hash> .node { background: <nodeColor> }`,
 * `.<hash> .node.hovering { background: #7b56db }` (the purple applied to
 * the hovered node + its connected path), and the label `<p>` color forced
 * with `!important`. Overrides:
 *   - dark mode: mid-tone fills (halfway between the stock colors and a
 *     pastel tint — user-tuned live against the running app) with
 *     dark-grey labels for readability, plus a slight vertical gradient.
 *   - light mode: the stock fills stay (blue base from the `nodeColor`
 *     option, viz purple on hover) with a translucent overlay gradient
 *     that works over BOTH fills without re-specifying them, and white
 *     labels (the viz's own rule forces near-black, unreadable on the
 *     dark-ish fills).
 *
 * Specificity notes: `&&` doubles this container's class so the
 * background rules out-rank the viz's `.<hash> .node[.hovering]` rules
 * without !important; the label rules DO need !important because the
 * viz's own label rule carries it (equal-importance → higher specificity
 * wins, and `&& button.node .center-content p:not(.badge)` out-ranks the
 * viz's `.<hash> .node p:not(.badge)` in both hover and rest states).
 */
const LinkGraphContainer = styled.div<{ $height: number; $mode: ThemeMode }>`
    width: 100%;
    height: ${(p) => p.$height}px;
    overflow-x: hidden;

    & * {
        overflow-x: hidden !important;
    }

    ${(p) =>
        p.$mode === 'dark'
            ? `
    && button.node {
        background-color: #4d9dbf;
        background-image: linear-gradient(180deg, #61a8c6 0%, #3992b8 100%);
    }
    && button.node.hovering {
        background-color: #9c80e4;
        background-image: linear-gradient(180deg, #a78ee7 0%, #9173e1 100%);
    }
    && button.node .center-content p:not(.badge),
    && button.node .right-content p:not(.badge) {
        color: #22282e !important;
    }
    `
            : `
    /* The overlay depth matches GradientWrap's light-mode 0.15 fade
     * convention. The .hovering repeat is required: the viz's hover rule
     * uses the 'background' SHORTHAND, which resets background-image —
     * without an own higher-specificity hover rule the gradient would
     * vanish while hovering. */
    && button.node,
    && button.node.hovering {
        background-image: linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.1) 0%,
            rgba(0, 0, 0, 0.15) 100%
        );
    }
    && button.node .center-content p:not(.badge),
    && button.node .right-content p:not(.badge) {
        color: #ffffff !important;
    }
    `}
`;

export default LinkGraphContainer;
