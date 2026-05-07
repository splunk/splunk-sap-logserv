import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

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
 *  e.g. "/platform/host-details" → "host-details". */
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

const triggerDownload = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Free the object URL on the next tick to ensure the click finished.
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Capture the dashboard root as a canvas at full content width × full
 *  scrollHeight. We snapshot the original scroll position, scroll to top
 *  before capture (html2canvas otherwise misses content above the current
 *  scroll), then restore. The `windowWidth` / `windowHeight` options
 *  expand the virtual viewport so off-screen content renders in the
 *  capture too — without this, html2canvas only paints what's currently
 *  in the viewport. */
const captureDashboardCanvas = async (root: HTMLElement): Promise<HTMLCanvasElement> => {
    const html2canvasMod = await import('html2canvas');
    const html2canvas = html2canvasMod.default;

    // Make sure the whole dashboard is visible to the rasterizer.
    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);

    const fullWidth = Math.max(root.scrollWidth, root.clientWidth);
    const fullHeight = Math.max(root.scrollHeight, root.clientHeight);

    try {
        const canvas = await html2canvas(root, {
            backgroundColor: '#0d1117', // matches logservTheme.colors.pageBackground
            useCORS: true,
            logging: false,
            scale: window.devicePixelRatio || 1,
            width: fullWidth,
            height: fullHeight,
            windowWidth: fullWidth,
            windowHeight: fullHeight,
            scrollX: 0,
            scrollY: 0,
        });
        return canvas;
    } finally {
        window.scrollTo(prevScrollX, prevScrollY);
    }
};

const ActionsDropdown: React.FC = () => {
    const [open, setOpen] = useState<boolean>(false);
    const [busy, setBusy] = useState<null | 'png' | 'pdf'>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

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
            const canvas = await captureDashboardCanvas(findCaptureRoot());
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
    }, [busy]);

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
            const canvas = await captureDashboardCanvas(findCaptureRoot());
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
            pdf.save(`${currentSlug()}-${todayStr()}.pdf`);
            setStatusMessage(null);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ActionsDropdown] PDF capture failed', err);
            setStatusMessage('Capture failed — see console.');
        } finally {
            setBusy(null);
        }
    }, [busy]);

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
                    {statusMessage && <StatusLine>{statusMessage}</StatusLine>}
                </Menu>
            )}
        </Wrapper>
    );
};

export default ActionsDropdown;
