import React from 'react';
import layout from '@splunk/react-page/18';
import App from './App';
import {
    applyBodyModeClass,
    injectThemeVarStylesheet,
    readInitialThemeMode,
} from './styles/magneticTokens';
import { injectFontFaceStylesheet } from './styles/fonts';

/* Cisco Magnetic re-theme Phase 0 (build 246): resolve the theme mode
 * BEFORE first paint — hash override → stored per-user choice → dark
 * (ratified default; light is the explicit opt-in via the mode toggle).
 *
 *  1. The body mode class goes on synchronously so the `--lsv-*` variable
 *     block (GlobalThemeVars) resolves correctly from the very first
 *     frame — no light/dark flash. The same call sets the root
 *     `color-scheme` (build 359), so the page scrollbar is drawn in the
 *     matching scheme from that first frame too.
 *  2. Splunk Web's own chrome takes the matching prisma theme via
 *     `layout()`. Runtime toggles re-theme the app tree instantly through
 *     the nested SplunkThemeScope provider; the outer chrome catches up
 *     on the next full page load (this line).
 */
const initialMode = readInitialThemeMode();
injectThemeVarStylesheet();
injectFontFaceStylesheet();
applyBodyModeClass(initialMode);

layout(<App />, {
    theme: initialMode,
    themeFamily: 'prisma',
    themeDensity: 'compact',
    /* Phase 7 (build 343): hide Splunk Web's APP BAR — the strip that renders
     * the app's title on the left and its icon + title again on the right.
     *
     * That bar exists to carry an app's own navigation. Ours now lives in the
     * Magnetic left rail, and our header carries the brand lockup, so the app
     * bar was showing the product name a third and fourth time and nothing
     * else. Removing it also removes a horizontal band whose styling we do
     * not control and cannot theme with the rest of the shell.
     *
     * The SPLUNK BAR above it is deliberately KEPT (`hideSplunkBar` stays
     * false): it is how an operator leaves this app, reaches Splunk's own
     * Settings, and sees system messages. `hideChrome` would have taken both,
     * plus the footer, and would have stranded the user inside our app. */
    hideAppBar: true,
});
