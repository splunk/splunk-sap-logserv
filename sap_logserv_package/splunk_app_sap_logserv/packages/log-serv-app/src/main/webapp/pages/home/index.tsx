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
 *     frame — no light/dark flash.
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
});
