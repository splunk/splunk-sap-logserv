import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { logservTheme } from '../styles/logservTheme';
import { useThemeMode } from '../state/ThemeModeProvider';
import { useTimeRange } from '../state/TimeRangeProvider';
import { useCloudProvider } from '../state/CloudProviderProvider';
import { getActivePageSnapshot } from '../state/DiagnosticCollector';
import { triggerDownload } from '../utils/download';
import { beginDiagnosis, endDiagnosis } from '../utils/diagProbe';
import { sweepDashboard, collectDashboardRollupSpl } from '../utils/diagSweep';
import { gatherEnvironmentEvidence } from '../utils/diagEnvironment';
import { probeIngestFacts } from '../utils/diagEvidence';
import { sanitizeFetchedFactsRow, IngestFacts } from '../utils/diagIngestFacts';
import {
    buildDashboardReportModel,
    buildEnvironmentReportModel,
    ReportMeta,
} from '../utils/diagReport';
import { downloadReport } from '../utils/diagReportPdf';
import { findDashboardByPath } from '../routes/dashboardRegistry';
import { APP_VERSION, APP_BUILD, APP_BUILD_DATE, TEMPLATES_ONLY } from '../buildFlags';

/**
 * ActionsDropdown — small button + popup menu rendered in the NavigationBar
 * (left of the AI Assistant button). Menu items:
 *
 *   • Download PNG — capture the current dashboard at full width × full
 *     scrollHeight and trigger a browser download.
 *   • Download PDF — same capture, packaged as a single-page PDF sized to
 *     the rendered dashboard.
 *
 * Capture target: the first ancestor with `data-dashboard-root="true"`,
 * which `DashboardLayout` adds to its outer wrapper. Using a stable data
 * attribute means we don't have to wire individual dashboards into the
 * download flow — every dashboard that passes through `DashboardLayout`
 * is downloadable for free.
 *
 * Library cost: html2canvas + jspdf together add ~150 KB to the bundle.
 * Both are dynamically imported inside the click handlers so they load
 * only when the user actually triggers a download — the default visit
 * pays nothing.
 */

const ActionsButton = styled.button<{ $active: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${(p) => (p.$active ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
    border: 1px solid ${(p) => (p.$active ? logservTheme.colors.cyanAccent : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    /* Explicit height matches the rendered height of the AI Assistant
     * button next to us. We can't rely on natural content-driven sizing
     * because the inner caret glyph "down-arrow" and the AI Assistant's
     * star glyph have different inline box metrics, which produced a
     * visible 2-3 px height difference between the two buttons. With
     * box-sizing border-box, this height includes the 1 px borders. */
    box-sizing: border-box;
    height: 32px;
    padding: 0 12px;
    margin-right: ${logservTheme.spacing.sm};
    align-self: center;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }

    &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
`;

const Caret = styled.span`
    /* Inherit font-size and line-height from the button so this caret
     * span doesn't shrink the button's inline content box and make the
     * button render shorter than its peers in the navigation bar. */
    margin-left: 2px;
`;

const Wrapper = styled.div`
    position: relative;
    display: inline-flex;
    align-items: center;
`;

const Menu = styled.div`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 180px;
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    padding: 4px 0;
`;

const MenuItem = styled.button`
    background: transparent;
    border: none;
    color: ${logservTheme.colors.textActive};
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    padding: 8px 12px;
    width: 100%;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanLight};
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const Icon = styled.span`
    font-size: 14px;
    line-height: 1;
    width: 16px;
    text-align: center;
`;

const StatusLine = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    padding: 6px 12px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

/** Capture root for screenshots / PDFs. We use document.body so the
 *  Splunk app header and our NavigationBar are included in the output
 *  (matching what the user sees on screen). The marked
 *  [data-dashboard-root] is still set inside the body — it just isn't the
 *  rasterization boundary anymore. */
const findCaptureRoot = (): HTMLElement => document.body;

/** Wait for the next animation frame so the React state update closing
 *  the dropdown menu has been committed and painted before we capture.
 *  Without this, the open menu can appear in the screenshot. */
const nextAnimationFrame = (): Promise<void> =>
    new Promise((resolve) => {
        window.requestAnimationFrame(() => {
            // One more rAF guarantees the previous frame's paint is committed
            // before html2canvas reads the DOM.
            window.requestAnimationFrame(() => resolve());
        });
    });

/** Slug from the current dashboard for use in the download filename.
 *  e.g. "/platform/host-details" -> "host-details". */
const currentSlug = (): string => {
    const hash = window.location.hash || '';
    // hash is "#/platform/host-details" (router) — strip leading "#" and split
    const path = hash.startsWith('#') ? hash.slice(1) : window.location.pathname;
    const parts = path.split(/[/?]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : 'dashboard';
};

const todayStr = (): string => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

/** Convert a base64 data URL to a Blob without going through fetch (works
 *  reliably with the file:// scheme and is faster for large strings). */
const dataUrlToBlob = (dataUrl: string): Blob => {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/data:([^;]+);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
};

// triggerDownload was extracted to `utils/download.ts` in session 095 so the
// Data Doctor report paths share the proven mechanism (build-256 lesson lives
// with the helper). Imported at the top of this file.

/* ─── Topology SVG pre-rasterization (build 273) ────────────────────────────
 *
 * html2canvas 1.4.1 misrenders the @xyflow/react canvas two ways:
 *   1. Every edge renders in its own UNSIZED <svg> (no width/height/viewBox
 *      — the CSS default 300×150 box) whose path draws far outside the box
 *      via `overflow: visible`. html2canvas rasterizes each <svg> clipped
 *      to its element box, so every edge (and its label) vanishes from the
 *      export.
 *   2. SVG replaced content under the viewport's CSS scale transform is
 *      drawn at the wrong scale/offset — the node health rings come out as
 *      oversized partial arcs.
 * Both were user-confirmed on a visible-window export (2026-07-07), so this
 * is not an occluded-window artifact.
 *
 * Fix: BEFORE invoking html2canvas, rasterize each topology svg through the
 * browser's NATIVE renderer (serialize -> data:image/svg+xml -> <img> ->
 * canvas -> PNG data URL), then swap the svgs for equivalent absolutely-
 * positioned <img> elements inside html2canvas's cloned document (onclone
 * is synchronous in 1.4.1, so all async work happens up front). Native
 * rasterization gets overflow, gradients, stroke-dasharray, markers and
 * text right by construction, and html2canvas handles plain <img> elements
 * under transforms correctly (the node HTML already renders fine).
 *
 * Scope: svgs inside `.react-flow` only, excluding the MiniMap (renders
 * correctly through the default path). Non-topology dashboards have no
 * `.react-flow` and take the unchanged pipeline. */

/** Presentation properties inlined onto serialized svg content so the
 *  standalone svg doesn't lose class-based / inherited styling. */
const RASTER_STYLE_PROPS = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-dashoffset',
    'stroke-linecap',
    'stroke-linejoin',
    'opacity',
    'fill-opacity',
    'stroke-opacity',
    'font-family',
    'font-size',
    'font-weight',
    'letter-spacing',
    'visibility',
] as const;

type SvgRasterRecord =
    | {
          kind: 'replace';
          dataUrl: string;
          left: number;
          top: number;
          width: number;
          height: number;
          zIndex: string;
          transform: string;
          transformOrigin: string;
      }
    | { kind: 'hide' }
    | { kind: 'leave' };

const loadImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('svg raster image failed to load'));
        img.src = url;
    });

/** Copy computed presentation styles from every element of the original svg
 *  onto the matching element of its detached clone. `url(#…)` values keep
 *  the original attribute/inline form (computed style absolutizes the URL,
 *  which breaks inside a standalone serialized svg). */
const inlinePresentationStyles = (orig: SVGSVGElement, clone: SVGSVGElement): void => {
    const origEls = [orig as Element, ...Array.from(orig.querySelectorAll('*'))];
    const cloneEls = [clone as Element, ...Array.from(clone.querySelectorAll('*'))];
    for (let i = 0; i < origEls.length && i < cloneEls.length; i += 1) {
        const o = origEls[i];
        const c = cloneEls[i] as SVGElement;
        const cs = window.getComputedStyle(o);
        RASTER_STYLE_PROPS.forEach((prop) => {
            const computed = cs.getPropertyValue(prop);
            if (!computed) return;
            if (computed.includes('url(')) {
                // Prefer the local-fragment form the markup already carries.
                const attr = o.getAttribute(prop) ?? (o as SVGElement).style.getPropertyValue(prop);
                if (attr) c.style.setProperty(prop, attr);
                return;
            }
            c.style.setProperty(prop, computed);
        });
    }
};

/** Rasterize the topology svgs to PNG data URLs. Returns one record per
 *  svg in DOM order under `.react-flow` (the same selector run happens in
 *  onclone to index-match the cloned document), or null when the capture
 *  root contains no topology canvas. Any per-svg failure degrades to
 *  'leave' (the pre-273 behavior) rather than aborting the export. */
const prerasterizeTopologySvgs = async (root: HTMLElement): Promise<SvgRasterRecord[] | null> => {
    const flow = root.querySelector('.react-flow');
    if (!flow) return null;
    const markerDefs = flow.querySelector('.react-flow__marker defs');
    const svgs = Array.from(flow.querySelectorAll('svg'));
    const records: SvgRasterRecord[] = [];
    for (const svg of svgs) {
        try {
            if (svg.closest('.react-flow__minimap')) {
                records.push({ kind: 'leave' });
                continue;
            }
            const cs = window.getComputedStyle(svg);
            if (cs.position !== 'absolute') {
                // Unknown positioning context (e.g. inline icon svgs) — those
                // already render acceptably through html2canvas; leave them.
                records.push({ kind: 'leave' });
                continue;
            }
            const bb = svg.getBBox();
            if (bb.width < 1 || bb.height < 1) {
                // Defs-only svgs (the marker container) — nothing to draw.
                records.push({ kind: 'hide' });
                continue;
            }
            const clone = svg.cloneNode(true) as SVGSVGElement;
            inlinePresentationStyles(svg, clone);

            // Content box for the raster. Unsized svgs (edges, background)
            // get re-boxed to their content bbox; svgs that already declare
            // a viewBox (health rings, icons) keep their own mapping.
            const PAD = 24; // stroke width + arrowhead overhang
            let boxX = 0;
            let boxY = 0;
            let boxW: number;
            let boxH: number;
            if (svg.hasAttribute('viewBox')) {
                boxW = parseFloat(cs.width) || bb.width + 2 * PAD;
                boxH = parseFloat(cs.height) || bb.height + 2 * PAD;
            } else {
                boxX = bb.x - PAD;
                boxY = bb.y - PAD;
                boxW = bb.width + 2 * PAD;
                boxH = bb.height + 2 * PAD;
                clone.setAttribute('viewBox', `${boxX} ${boxY} ${boxW} ${boxH}`);
                clone.setAttribute('width', String(boxW));
                clone.setAttribute('height', String(boxH));
            }
            // Cross-svg marker refs (arrowheads live in the shared
            // .react-flow__marker defs svg) must be inlined for the
            // standalone serialization to resolve them.
            if (markerDefs && clone.querySelector('[marker-end], [marker-start]')) {
                clone.insertBefore(markerDefs.cloneNode(true), clone.firstChild);
            }
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

            const xml = new XMLSerializer().serializeToString(clone);
            const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
            const img = await loadImage(svgUrl);
            // Supersample small svgs for crispness; cap the pixel budget so a
            // large background raster can't blow memory.
            const rasterScale = Math.max(0.75, Math.min(2, Math.sqrt(4_000_000 / (boxW * boxH))));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(boxW * rasterScale));
            canvas.height = Math.max(1, Math.round(boxH * rasterScale));
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                records.push({ kind: 'leave' });
                continue;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            records.push({
                kind: 'replace',
                dataUrl: canvas.toDataURL('image/png'),
                left: (parseFloat(cs.left) || 0) + boxX,
                top: (parseFloat(cs.top) || 0) + boxY,
                width: boxW,
                height: boxH,
                zIndex: cs.zIndex,
                // The health-ring svgs center themselves on the disc via
                // `transform: translate(-50%, -50%)` — the replacement <img>
                // must carry the same transform or every ring lands offset
                // by half its own size (caught in the build-273 verify).
                transform: cs.transform,
                transformOrigin: cs.transformOrigin,
            });
        } catch {
            records.push({ kind: 'leave' });
        }
    }
    return records;
};

/** Apply the pre-rasterized records inside html2canvas's cloned document —
 *  the clone preserves DOM order, so the selector run index-matches. */
const applySvgRastersToClone = (clonedDoc: Document, records: SvgRasterRecord[]): void => {
    const flowClone = clonedDoc.querySelector('.react-flow');
    if (!flowClone) return;
    const cloneSvgs = Array.from(flowClone.querySelectorAll('svg'));
    for (let i = 0; i < cloneSvgs.length && i < records.length; i += 1) {
        const rec = records[i];
        const svg = cloneSvgs[i];
        if (rec.kind === 'leave') continue;
        if (rec.kind === 'hide') {
            (svg as SVGElement).style.display = 'none';
            continue;
        }
        const img = clonedDoc.createElement('img');
        img.src = rec.dataUrl;
        img.style.position = 'absolute';
        img.style.left = `${rec.left}px`;
        img.style.top = `${rec.top}px`;
        img.style.width = `${rec.width}px`;
        img.style.height = `${rec.height}px`;
        if (rec.zIndex && rec.zIndex !== 'auto') img.style.zIndex = rec.zIndex;
        if (rec.transform && rec.transform !== 'none') {
            img.style.transform = rec.transform;
            img.style.transformOrigin = rec.transformOrigin;
        }
        svg.replaceWith(img);
    }
};

/** Capture the dashboard root as a canvas at full content width × full
 *  scrollHeight. We snapshot the original scroll position, scroll to top
 *  before capture (html2canvas otherwise misses content above the current
 *  scroll), then restore. The `windowWidth` / `windowHeight` options
 *  expand the virtual viewport so off-screen content renders in the
 *  capture too — without this, html2canvas only paints what's currently
 *  in the viewport. */
const captureDashboardCanvas = async (root: HTMLElement, bgColor: string): Promise<HTMLCanvasElement> => {
    const html2canvasMod = await import('html2canvas');
    const html2canvas = html2canvasMod.default;

    // Rasterize the topology svgs through the native renderer first — see
    // the block comment above (html2canvas clips/mis-scales them). No-op
    // (null) on dashboards without a topology canvas.
    const svgRasters = await prerasterizeTopologySvgs(root);

    // Make sure the whole dashboard is visible to the rasterizer.
    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);

    const fullWidth = Math.max(root.scrollWidth, root.clientWidth);
    const fullHeight = Math.max(root.scrollHeight, root.clientHeight);

    try {
        const canvas = await html2canvas(root, {
            // Resolved per-mode page background (Surface 2 — html2canvas needs a
            // literal color, var() refs don't resolve here). Build 254; was a
            // hardcoded pre-Magnetic '#0d1117'.
            backgroundColor: bgColor,
            useCORS: true,
            logging: false,
            scale: window.devicePixelRatio || 1,
            width: fullWidth,
            height: fullHeight,
            windowWidth: fullWidth,
            windowHeight: fullHeight,
            scrollX: 0,
            scrollY: 0,
            onclone: svgRasters
                ? (clonedDoc: Document) => applySvgRastersToClone(clonedDoc, svgRasters)
                : undefined,
        });
        return canvas;
    } finally {
        window.scrollTo(prevScrollX, prevScrollY);
    }
};

/** Human dashboard label for the report scope line — registry name when the
 *  current hash path is a registered dashboard, the slug otherwise. */
const currentDashboardLabel = (): string => {
    const hash = window.location.hash || '';
    const path = (hash.startsWith('#') ? hash.slice(1) : window.location.pathname).split('?')[0];
    const dash = findDashboardByPath(path);
    return dash ? dash.name : currentSlug();
};

const reportMeta = (): ReportMeta => ({
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    appBuildDate: APP_BUILD_DATE,
    templatesOnly: TEMPLATES_ONLY,
    username: splunkUsername || '',
});

const ActionsDropdown: React.FC = () => {
    const [open, setOpen] = useState<boolean>(false);
    const [busy, setBusy] = useState<null | 'png' | 'pdf' | 'diag' | 'env'>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    // Mode-resolved page background for the PNG/PDF capture (build 254).
    const { tokens } = useThemeMode();
    const { timeRange } = useTimeRange();
    const { provider } = useCloudProvider();

    // Close on outside click / escape.
    useEffect(() => {
        if (!open) return undefined;
        const onDocClick = (e: MouseEvent): void => {
            const node = e.target as Node | null;
            if (wrapperRef.current && node && !wrapperRef.current.contains(node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const handleDownloadPng = useCallback(async (): Promise<void> => {
        if (busy) return;
        setBusy('png');
        setStatusMessage('Capturing dashboard…');
        // Close the menu BEFORE capture so the open dropdown panel doesn't
        // appear in the screenshot. Wait two animation frames for React's
        // state commit + paint.
        setOpen(false);
        await nextAnimationFrame();
        try {
            const canvas = await captureDashboardCanvas(findCaptureRoot(), tokens.pageBackground);
            const dataUrl = canvas.toDataURL('image/png');
            const blob = dataUrlToBlob(dataUrl);
            triggerDownload(blob, `${currentSlug()}-${todayStr()}.png`);
            setStatusMessage(null);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ActionsDropdown] PNG capture failed', err);
            setStatusMessage('Capture failed — see console.');
        } finally {
            setBusy(null);
        }
    }, [busy, tokens.pageBackground]);

    const handleDownloadPdf = useCallback(async (): Promise<void> => {
        if (busy) return;
        setBusy('pdf');
        setStatusMessage('Capturing dashboard…');
        // Close the menu BEFORE capture so the open dropdown panel doesn't
        // appear in the screenshot. Wait two animation frames for React's
        // state commit + paint.
        setOpen(false);
        await nextAnimationFrame();
        try {
            const canvas = await captureDashboardCanvas(findCaptureRoot(), tokens.pageBackground);
            const jsPdfMod = await import('jspdf');
            const JsPdf = jsPdfMod.jsPDF;

            // Match the PDF page exactly to the captured canvas — Dashboard
            // Studio's Download PDF behaves the same way (one page per
            // dashboard, scaled to the dashboard's rendered dimensions).
            const widthPx = canvas.width;
            const heightPx = canvas.height;
            const pdf = new JsPdf({
                orientation: widthPx >= heightPx ? 'l' : 'p',
                unit: 'px',
                format: [widthPx, heightPx],
                hotfixes: ['px_scaling'],
            });
            // JPEG keeps the file small for the dark-themed canvas (the
            // chart panels are mostly solid colors); the small artifacts
            // around antialiased text are acceptable for a screenshot.
            const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
            pdf.addImage(dataUrl, 'JPEG', 0, 0, widthPx, heightPx);
            // Route through OUR download helper instead of jsPDF's internal
            // save()/FileSaver — jsPDF 4.x's own anchor+revoke mechanism
            // fails with Chrome's "Something went wrong" once the user picks
            // a save location, while the PNG path (same helper) works. One
            // proven download mechanism for both buttons (build 256).
            triggerDownload(pdf.output('blob'), `${currentSlug()}-${todayStr()}.pdf`);
            setStatusMessage(null);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ActionsDropdown] PDF capture failed', err);
            setStatusMessage('Capture failed — see console.');
        } finally {
            setBusy(null);
        }
    }, [busy, tokens.pageBackground]);

    /* ── Session 095 — the Data Doctor reports (design §6 entry points 3/4,
     * §7). Both keep the MENU OPEN so the StatusLine shows live progress, and
     * both run through the app-wide `beginDiagnosis` singleton: starting one
     * supersedes any drawer diagnosis in flight, and probes stay budgeted +
     * concurrency-capped on a machine that may already be struggling. Closing
     * the menu mid-run does not cancel — the run is bounded by its budget and
     * every probe carries server-side auto_cancel. */

    const handleDiagnoseDashboard = useCallback(async (): Promise<void> => {
        if (busy) return;
        const snapshot = getActivePageSnapshot();
        if (snapshot.length === 0) {
            setStatusMessage('No panels are registered on this page — open a dashboard first.');
            return;
        }
        setBusy('diag');
        setStatusMessage('Diagnosing…');
        const runner = beginDiagnosis({ budgetMs: 180_000, concurrency: 2 });
        try {
            // §15.8a-28 — the dashboard report takes the operator facts as an
            // explicit input, fetched ONCE at sweep start via the runner (a
            // healthy dashboard diagnoses zero panels, so there may be no
            // evidence object to derive them from). Deduped with the
            // per-panel fetches by the memoizing runner.
            let sweepIngestFacts: IngestFacts | null = null;
            const fx = await probeIngestFacts(runner);
            if (!fx.skipped && !fx.error) {
                const rows = fx.rows as unknown[];
                sweepIngestFacts =
                    rows.length > 0
                        ? sanitizeFetchedFactsRow(rows[0], Math.floor(Date.now() / 1000))
                        : null;
            }
            const sweep = await sweepDashboard(runner, snapshot, provider, (done, total) => {
                setStatusMessage(
                    total === 0
                        ? 'No empty panels — compiling the report…'
                        : `Diagnosing empty panel ${Math.min(done + 1, total)} of ${total}…`,
                );
            });
            // Superseded (another diagnosis called beginDiagnosis — e.g. the
            // #/diagnostics page's auto-run, or the drawer): every remaining
            // probe resolved `skipped`, so the sweep RESOLVED with junk
            // evidence. Downloading (and thereby persisting) an
            // all-NOT-CHECKED support artifact would be worse than nothing —
            // skip both and say why (session-096 review, L2-F2).
            if (runner.isCancelled()) {
                setStatusMessage('Superseded by another diagnosis — run it again.');
                return;
            }
            /* §20.3 — the whole dashboard's rollup-populating SPL, collected
             * ALONGSIDE the sweep (never on SweepResult — §20.8a-5) and passed
             * to the builder explicitly. Returns null when the budget is gone
             * (the section is honestly absent, never a list of blanks). */
            const rollupSearches = await collectDashboardRollupSpl(runner, snapshot);
            if (runner.isCancelled()) {
                setStatusMessage('Superseded by another diagnosis — run it again.');
                return;
            }
            setStatusMessage('Rendering the report…');
            const model = buildDashboardReportModel({
                dashboardLabel: currentDashboardLabel(),
                sweep,
                meta: reportMeta(),
                ingestFacts: sweepIngestFacts,
                rollupSearches,
            });
            await downloadReport(model);
            setStatusMessage(null);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ActionsDropdown] dashboard diagnosis failed', err);
            setStatusMessage('Diagnosis failed — see console.');
        } finally {
            endDiagnosis(runner);
            setBusy(null);
        }
    }, [busy, provider]);

    const handleEnvironmentReport = useCallback(async (): Promise<void> => {
        if (busy) return;
        setBusy('env');
        setStatusMessage('Checking the environment…');
        const runner = beginDiagnosis({ budgetMs: 120_000, concurrency: 2 });
        try {
            const env = await gatherEnvironmentEvidence(
                runner,
                timeRange.earliest,
                timeRange.latest,
                (label) => setStatusMessage(label),
                // §17.8a-18 — the report wants per-rollup bucket-continuity; the
                // live Diagnostics page does not (it re-gathers on every change).
                { bucketContinuity: true },
            );
            // Same supersede guard as the dashboard sweep above: a cancelled
            // gather RESOLVES (skipped probes, not-checked rows) — never
            // download or persist that as a report (session-096 review, L2-F2).
            if (runner.isCancelled()) {
                setStatusMessage('Superseded by another diagnosis — run it again.');
                return;
            }
            setStatusMessage('Rendering the report…');
            const model = buildEnvironmentReportModel({
                env,
                windowLabel: `${timeRange.earliest} -> ${timeRange.latest}`,
                meta: reportMeta(),
            });
            await downloadReport(model);
            setStatusMessage(null);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ActionsDropdown] environment report failed', err);
            setStatusMessage('Diagnosis failed — see console.');
        } finally {
            endDiagnosis(runner);
            setBusy(null);
        }
    }, [busy, timeRange.earliest, timeRange.latest]);

    return (
        <Wrapper ref={wrapperRef}>
            <ActionsButton
                type="button"
                onClick={() => setOpen((v) => !v)}
                $active={open}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Dashboard actions"
                disabled={busy !== null}
            >
                Actions
                <Caret aria-hidden>▾</Caret>
            </ActionsButton>
            {open && (
                <Menu role="menu">
                    <MenuItem
                        type="button"
                        role="menuitem"
                        onClick={handleDownloadPng}
                        disabled={busy !== null}
                    >
                        <Icon aria-hidden>↓</Icon>
                        Download PNG
                    </MenuItem>
                    <MenuItem
                        type="button"
                        role="menuitem"
                        onClick={handleDownloadPdf}
                        disabled={busy !== null}
                    >
                        <Icon aria-hidden>↓</Icon>
                        Download PDF
                    </MenuItem>
                    <MenuItem
                        type="button"
                        role="menuitem"
                        onClick={handleDiagnoseDashboard}
                        disabled={busy !== null}
                        title="Run the Data Doctor over every panel on this dashboard and download the report (PDF + JSON)"
                    >
                        <Icon aria-hidden>✚</Icon>
                        Diagnose dashboard (PDF)
                    </MenuItem>
                    <MenuItem
                        type="button"
                        role="menuitem"
                        onClick={handleEnvironmentReport}
                        disabled={busy !== null}
                        title="Index, sourcetype and summarised-data health for the whole environment — download the report (PDF + JSON)"
                    >
                        <Icon aria-hidden>✚</Icon>
                        Environment report (PDF)
                    </MenuItem>
                    {statusMessage && <StatusLine>{statusMessage}</StatusLine>}
                </Menu>
            )}
        </Wrapper>
    );
};

export default ActionsDropdown;
