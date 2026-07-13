/**
 * Magnetic font bundle — @font-face injection (Phase 1b, build 254; plan
 * §2.3). The font files ship in the app itself at
 * `appserver/static/fonts/` (no CDN — a Splunk app must be self-contained)
 * and Splunk Web serves them at `/<locale>/static/app/<app>/fonts/<file>`.
 *
 * Families (mirroring Harbor base.css's stacks):
 *   - "Inter" 400/500/600/700 (OFL 1.1)       → body/UI text
 *   - "Sharp Sans" 700 (Cisco-licensed)       → page titles (v0.1.1 is the
 *     internal line; if this ever ports to the public v0.0.6 line, Sharp
 *     Sans must be dropped — Inter 700 is the fallback — unless licensing
 *     is cleared. Plan §2.3 flag.)
 *   - "Roboto Mono" 400 (Apache-2.0)          → code / SPL blocks
 *
 * Font-file attribution lives in THIRD-PARTY-NOTICES.md (emitted by
 * bin/generate-third-party-notices.js — the npm walker can't see font
 * files, so the generator carries a hand-maintained section) and the
 * license texts under LICENSES/.
 *
 * Injection follows the injectThemeVarStylesheet() pattern: a plain
 * <style> appended to <head>, idempotent, callable synchronously from
 * pages/home/index.tsx BEFORE React mounts. `font-display: swap` keeps
 * first paint on the fallback stack instead of blocking on the ~300 KB
 * TTFs.
 */

import { app as splunkApp } from '@splunk/splunk-utils/config';

const FONT_FACE_STYLE_ATTR = 'data-lsv-font-faces';

/** `/<locale>/static/app/<app>/fonts/` — locale derived from the current
 *  page path (`/en-US/app/...`), falling back to `en-US`; app name from
 *  @splunk/splunk-utils config, falling back to the literal id. */
const fontBaseUrl = (): string => {
    let locale = 'en-US';
    try {
        const m = window.location.pathname.match(/^\/([^/]+)\/(?:app|manager)\//);
        if (m) locale = m[1];
    } catch (_e) {
        /* ignore */
    }
    const appId =
        typeof splunkApp === 'string' && splunkApp ? splunkApp : 'splunk_app_sap_logserv';
    return `/${locale}/static/app/${appId}/fonts/`;
};

interface FontFaceDef {
    family: string;
    weight: number;
    file: string;
    format: 'truetype' | 'woff2';
}

const FONT_FACES: FontFaceDef[] = [
    { family: 'Inter', weight: 400, file: 'Inter-Regular.ttf', format: 'truetype' },
    { family: 'Inter', weight: 500, file: 'Inter-Medium.ttf', format: 'truetype' },
    { family: 'Inter', weight: 600, file: 'Inter-SemiBold.ttf', format: 'truetype' },
    { family: 'Inter', weight: 700, file: 'Inter-Bold.ttf', format: 'truetype' },
    { family: 'Sharp Sans', weight: 700, file: 'SharpSans-Bold.woff2', format: 'woff2' },
    { family: 'Roboto Mono', weight: 400, file: 'RobotoMono-Regular.ttf', format: 'truetype' },
];

export const injectFontFaceStylesheet = (): void => {
    if (typeof document === 'undefined') return;
    if (document.head.querySelector(`style[${FONT_FACE_STYLE_ATTR}]`)) return;
    const base = fontBaseUrl();
    const el = document.createElement('style');
    el.setAttribute(FONT_FACE_STYLE_ATTR, '');
    el.textContent = FONT_FACES.map(
        (f) => `@font-face {
    font-family: "${f.family}";
    font-style: normal;
    font-weight: ${f.weight};
    font-display: swap;
    src: url("${base}${f.file}") format("${f.format}");
}`,
    ).join('\n');
    document.head.appendChild(el);
};
