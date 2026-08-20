/**
 * diagReportPdf — render a `DiagReportModel` as a PDF (session 095, design §7).
 *
 * TEXT, NOT PIXELS. The dashboard-screenshot path (ActionsDropdown) rasterizes
 * with html2canvas because the deliverable IS the pixels; a support artifact
 * is the opposite case — the vendor needs selectable, searchable, greppable
 * text, and the session-078/059 lessons make DOM capture the wrong tool for a
 * generated document. Everything here is jsPDF's text API on A4 portrait.
 *
 * No `jspdf-autotable`: a new dependency means AppInspect + SBOM + notices
 * churn for two table shapes that hand-lay in ~60 lines. jsPDF itself is
 * lazy-imported so the ~100 KB library keeps loading only when a download is
 * actually requested (same pattern as the screenshot path).
 *
 * Downloads go through the extracted `triggerDownload` — the ONE proven
 * mechanism (build-256 Chrome save-dialog lesson lives with the helper).
 */

import { DiagReportModel, ReportBlock, ReportTable } from './diagReport';
import { triggerDownload } from './download';
import { persistReport } from './diagPersistence';

// A4 portrait in points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_ZONE = 40;

const SIZE_TITLE = 17;
const SIZE_SECTION = 11.5;
const SIZE_BODY = 9;
const SIZE_MONO = 7.3;
const SIZE_FOOTER = 7.5;

/** §20.8a-13 — the renderer's per-block cap, EXPORTED so the build gate can
 *  assert `RAW_SAMPLE_EVENT_MAX_CHARS <= MONO_BLOCK_MAX_CHARS`: the sample
 *  collector's disclosed truncation marker must always be the one the PDF
 *  reader sees, never this renderer-level one. */
export const MONO_BLOCK_MAX_CHARS = 60_000;

const LINE_GAP = 1.35;

// Minimal structural typing for the jsPDF surface we use — the real type
// lives in the lazy-imported module.
interface JsPdfDoc {
    setFont(name: string, style?: string): void;
    setFontSize(n: number): void;
    setTextColor(r: number, g?: number, b?: number): void;
    setDrawColor(r: number, g?: number, b?: number): void;
    setLineWidth(n: number): void;
    text(t: string | string[], x: number, y: number): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    rect(x: number, y: number, w: number, h: number): void;
    splitTextToSize(t: string, w: number): string[];
    addPage(): void;
    setPage(n: number): void;
    getNumberOfPages(): number;
    output(kind: 'blob'): Blob;
}

class Writer {
    doc: JsPdfDoc;

    y: number = MARGIN;

    constructor(doc: JsPdfDoc) {
        this.doc = doc;
    }

    ensure(height: number): void {
        if (this.y + height > PAGE_H - FOOTER_ZONE) {
            this.doc.addPage();
            this.y = MARGIN;
        }
    }

    gap(h: number): void {
        this.y += h;
    }

    /** Wrapped text at a given x/width. Page-break aware per line. */
    text(t: string, opts: { x?: number; width?: number; size?: number; bold?: boolean; mono?: boolean; gray?: boolean }): void {
        const size = opts.size ?? SIZE_BODY;
        const lineH = size * LINE_GAP;
        this.doc.setFont(opts.mono ? 'courier' : 'helvetica', opts.bold ? 'bold' : 'normal');
        this.doc.setFontSize(size);
        this.doc.setTextColor(opts.gray ? 105 : 30);
        const lines = this.doc.splitTextToSize(t, opts.width ?? CONTENT_W);
        for (let i = 0; i < lines.length; i += 1) {
            this.ensure(lineH);
            this.doc.text(lines[i], opts.x ?? MARGIN, this.y + size);
            this.y += lineH;
        }
    }

    sectionHeading(t: string): void {
        this.ensure(SIZE_SECTION * LINE_GAP + 16);
        this.gap(10);
        this.doc.setDrawColor(150);
        this.doc.setLineWidth(0.6);
        this.doc.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
        this.gap(6);
        this.text(t.toUpperCase(), { size: SIZE_SECTION, bold: true });
        this.gap(2);
    }

    keyValue(label: string, value: string): void {
        const labelW = 132;
        const valueW = CONTENT_W - labelW - 8;
        const size = SIZE_BODY;
        const lineH = size * LINE_GAP;
        this.doc.setFont('helvetica', 'bold');
        this.doc.setFontSize(size);
        const valueLines = this.doc.splitTextToSize(value || '—', valueW);
        const blockH = Math.max(1, valueLines.length) * lineH;
        this.ensure(blockH);
        this.doc.setTextColor(30);
        this.doc.setFont('helvetica', 'bold');
        this.doc.text(this.doc.splitTextToSize(label, labelW)[0] || label, MARGIN, this.y + size);
        this.doc.setFont('helvetica', 'normal');
        for (let i = 0; i < valueLines.length; i += 1) {
            // A very long value can still cross a page boundary mid-block.
            if (this.y + lineH > PAGE_H - FOOTER_ZONE) {
                this.doc.addPage();
                this.y = MARGIN;
            }
            this.doc.text(valueLines[i], MARGIN + labelW + 8, this.y + size);
            this.y += lineH;
        }
        this.gap(2);
    }

    table(t: ReportTable): void {
        const size = 8;
        const lineH = size * LINE_GAP;
        const cols = t.columns.length;
        const wrapIdx = typeof t.wrapColumn === 'number' ? t.wrapColumn : cols - 1;
        // Fixed columns get a width proportional to their header + typical
        // content (bounded); the wrap column takes the remainder.
        const fixedW = Math.min(120, Math.max(52, CONTENT_W / (cols + 1)));
        const widths: number[] = [];
        let used = 0;
        for (let i = 0; i < cols; i += 1) {
            if (i === wrapIdx) widths.push(0);
            else {
                widths.push(fixedW);
                used += fixedW;
            }
        }
        widths[wrapIdx] = CONTENT_W - used - (cols - 1) * 6;

        const drawRow = (cells: string[], bold: boolean): void => {
            this.doc.setFont('helvetica', bold ? 'bold' : 'normal');
            this.doc.setFontSize(size);
            this.doc.setTextColor(30);
            const wrapped: string[][] = cells.map((c, i) =>
                this.doc.splitTextToSize(String(c ?? ''), widths[i]),
            );
            const rowLines = wrapped.reduce((a, w) => Math.max(a, w.length), 1);
            const rowH = rowLines * lineH + 3;
            this.ensure(rowH + (bold ? 4 : 0));
            let x = MARGIN;
            for (let i = 0; i < cols; i += 1) {
                const cell = wrapped[i];
                for (let l = 0; l < cell.length; l += 1) {
                    this.doc.text(cell[l], x, this.y + size + l * lineH);
                }
                x += widths[i] + 6;
            }
            this.y += rowH;
            if (bold) {
                this.doc.setDrawColor(150);
                this.doc.setLineWidth(0.4);
                this.doc.line(MARGIN, this.y - 2, PAGE_W - MARGIN, this.y - 2);
                this.gap(2);
            }
        };

        drawRow(t.columns, true);
        for (let r = 0; r < t.rows.length; r += 1) drawRow(t.rows[r], false);
        this.gap(4);
    }

    mono(text: string): void {
        // Cap pathological appendices; the .json file is the machine channel.
        const capped =
            text.length > MONO_BLOCK_MAX_CHARS
                ? `${text.slice(0, MONO_BLOCK_MAX_CHARS)}\n… truncated (${text.length.toLocaleString()} characters total) …`
                : text;
        this.gap(2);
        this.text(capped, { size: SIZE_MONO, mono: true });
        this.gap(2);
    }

    banner(text: string): void {
        const size = 8;
        const lineH = size * LINE_GAP;
        this.doc.setFont('helvetica', 'normal');
        this.doc.setFontSize(size);
        const lines = this.doc.splitTextToSize(text, CONTENT_W - 20);
        const boxH = lines.length * lineH + 14;
        this.ensure(boxH + 6);
        this.doc.setDrawColor(120);
        this.doc.setLineWidth(0.8);
        this.doc.rect(MARGIN, this.y, CONTENT_W, boxH);
        this.doc.setTextColor(60);
        for (let i = 0; i < lines.length; i += 1) {
            this.doc.text(lines[i], MARGIN + 10, this.y + 10 + size + i * lineH - size + size);
        }
        this.y += boxH;
        this.gap(8);
    }
}

/** Render the model. Exported separately from the download wrapper so a
 *  future persistence path can reuse the same bytes. */
export const renderReportPdf = async (model: DiagReportModel): Promise<Blob> => {
    const jsPdfMod = await import('jspdf');
    const JsPdf = jsPdfMod.jsPDF;
    const doc = new JsPdf({ orientation: 'p', unit: 'pt', format: 'a4' }) as unknown as JsPdfDoc;
    const w = new Writer(doc);

    // Cover block.
    w.text(model.title, { size: SIZE_TITLE, bold: true });
    w.gap(2);
    w.text(model.scopeLine, { size: 10.5 });
    w.gap(4);
    w.banner(model.banner);
    w.keyValue('Report ID', model.reportId);
    w.keyValue('Generated', `${model.generatedAtLocal} · ${model.generatedAtUtc}`);
    w.keyValue('Generated by', model.meta.username || '(unknown user)');
    w.keyValue(
        'App',
        `Splunk for SAP LogServ ${model.meta.appVersion} (build ${model.meta.appBuild}, ${model.meta.appBuildDate})` +
            (model.meta.templatesOnly ? ' — templates-only build' : ''),
    );

    for (let s = 0; s < model.sections.length; s += 1) {
        const section = model.sections[s];
        w.sectionHeading(section.heading);
        for (let b = 0; b < section.blocks.length; b += 1) {
            const block: ReportBlock = section.blocks[b];
            if (block.kind === 'keyValues') {
                for (let i = 0; i < block.items.length; i += 1) {
                    w.keyValue(block.items[i].label, block.items[i].value);
                }
            } else if (block.kind === 'paragraphs') {
                for (let i = 0; i < block.text.length; i += 1) {
                    w.text(block.text[i], {});
                    w.gap(4);
                }
            } else if (block.kind === 'table') {
                w.table(block.table);
            } else {
                w.mono(block.text);
            }
        }
    }

    // Footers — after all content so `Page n of m` is known.
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p += 1) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(SIZE_FOOTER);
        doc.setTextColor(120);
        doc.text(
            `${model.title} · ${model.reportId} · v${model.meta.appVersion} build ${model.meta.appBuild} · Page ${p} of ${pages}`,
            MARGIN,
            PAGE_H - 22,
        );
    }

    return doc.output('blob');
};

/** Render + download in one step (PDF plus the machine-readable JSON twin —
 *  design §7.11 wants the appendix greppable and diffable, which a PDF-embedded
 *  copy alone is not).
 *
 *  Session 096: every download is also BEST-EFFORT persisted to the
 *  `logserv_diag_reports` KV collection (decision 5's other half) so the
 *  `#/diagnostics` page can list + re-download it. Fire-and-forget — a failed
 *  persist never blocks or breaks the download the user asked for. The
 *  saved-reports RE-download path on the diagnostics page deliberately calls
 *  `renderReportPdf` + `triggerDownload` directly, NEVER this function, so a
 *  re-download can never re-persist. */
export const downloadReport = async (model: DiagReportModel, withJson = true): Promise<void> => {
    /* SS16.8a-25 — DERIVED, so no call site can forget: a sample-bearing
     * report is download-only. Persisting raw events into the world-readable,
     * system-exported reports collection would bypass index ACLs (a user who
     * cannot search the index could read another user's samples).
     * `persistReport` REFUSES such models independently (belt and braces). */
    const hasSamples = model.json && model.json.rawSamples != null;
    if (!hasSamples) {
        void persistReport(model).then((r) => {
            if (!r.ok) {
                // eslint-disable-next-line no-console
                console.warn('[diagPersistence] report not persisted:', r.reason);
            }
        });
    }
    const blob = await renderReportPdf(model);
    triggerDownload(blob, `${model.filenameBase}.pdf`);
    if (withJson) {
        const jsonBlob = new Blob([JSON.stringify(model.json, null, 2)], {
            type: 'application/json',
        });
        triggerDownload(jsonBlob, `${model.filenameBase}.json`);
    }
};
