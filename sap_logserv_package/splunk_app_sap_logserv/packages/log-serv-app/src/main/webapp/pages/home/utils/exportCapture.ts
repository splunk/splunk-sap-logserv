/**
 * exportCapture - what Download PNG / Download PDF do around html2canvas so an
 * export shows the page at rest (build 368, session 142).
 *
 * html2canvas 1.4.1 draws a CLONE of the document in a hidden iframe, and for
 * every SVG element it copies all computed styles inline onto the clone - the
 * current `transform` included. The help icon's square (DocsHelpIcon: one turn
 * over 2.4 s at each end of a 12 s cycle) is an animated <svg>, so an export
 * showed it at whatever angle it had at that instant: tilted whenever the
 * download was clicked mid-turn (4 of every 10 seconds).
 *
 *   1. pauseLiveAnimationsAtStart - THE FIX. Before html2canvas runs, pause every
 *      running CSS animation of the live page at its start, so the values copied
 *      inline are the resting ones (the square upright). The returned function
 *      puts each animation back where it was and resumes it after the capture.
 *   2. freezeAnimationsInClone - insurance. In html2canvas's onclone hook, stop
 *      every animation and transition in the clone. With html2canvas 1.4.1 the
 *      clone's own animations made no visible difference (session 142 measured
 *      it: this step alone left every mid-turn export tilted, the pause alone
 *      made all of them upright), but a later html2canvas that let them run
 *      before drawing would move the square again; stopping them costs nothing.
 *
 * The app's animations (the help icon, the loading spinners, the refresh pulse)
 * all rest in a visible state, so nothing disappears from an export. CSS
 * transitions are left alone on the live page: they end by themselves.
 */

/** Pause each running CSS animation of `doc` at its start; return the resume function. */
export const pauseLiveAnimationsAtStart = (doc: Document): (() => void) => {
    const all: Animation[] = typeof doc.getAnimations === 'function' ? doc.getAnimations() : [];
    const paused: Array<{ animation: Animation; time: CSSNumberish | null }> = [];
    all.forEach((animation) => {
        if (typeof CSSAnimation !== 'undefined' && !(animation instanceof CSSAnimation)) return;
        if (animation.playState !== 'running') return;
        paused.push({ animation, time: animation.currentTime });
        animation.pause();
        animation.currentTime = 0;
    });
    return () => {
        paused.forEach(({ animation, time }) => {
            animation.currentTime = time;
            animation.play();
        });
    };
};

/** Stop every animation and transition in the document html2canvas renders. */
export const freezeAnimationsInClone = (clonedDoc: Document): void => {
    const style = clonedDoc.createElement('style');
    style.setAttribute('data-logserv-export', 'freeze-animations');
    style.textContent =
        '*, *::before, *::after { animation: none !important; transition: none !important; }';
    (clonedDoc.head || clonedDoc.documentElement).appendChild(style);
};

/*
 * Build 402: text that html2canvas 1.4.1 drew differently from the screen.
 * It places each word where the clone's layout puts it (DOM ranges) but draws
 * it with canvas text, which knows neither font-variant-numeric nor
 * font-feature-settings, nor the ways the page cuts text short
 * (-webkit-line-clamp, text-overflow: ellipsis).
 *
 *   3. normalizeNumericGlyphsInClone - tabular digits in the clone's layout
 *      (font-variant-numeric: tabular-nums, or font-feature-settings 'tnum' as
 *      on the KPI cards and the table footers), proportional digits on the
 *      canvas: a time such as 2026-11-17 17:10 in the Host Names list was drawn
 *      as "2026-11 -17 17 :10". The clone lays its text out as the canvas draws
 *      it; the screen keeps its tabular digits.
 *   4. ellipsizeCutTextInClone - a host name cut short on screen (in builds
 *      400-402 the name in a narrow table column gave way first,
 *      components/HostName.tsx) was drawn with its last words simply missing
 *      and no ellipsis, so "Reporting Server" read as "Reporting". In the
 *      clone, every text the page cuts with a one-line clamp or an ellipsis is
 *      shortened to what fits and ends in a real ellipsis character; text that
 *      fits is left whole; a hidden element is left alone. Widths are layout
 *      widths, never getBoundingClientRect: that one includes the transforms of
 *      the ancestors (the topology's zoom), which html2canvas lays out without.
 *      Build 403: HostName's line is one run of text (the name, then the raw
 *      value) in a box marked data-export-line, cut at its right end; the clone
 *      cuts it the same way (fitLine): the raw value first, the name only
 *      after it, the ellipsis at the end.
 *
 *   5. replaceFormTextInClone (build 406) - what is typed in a text box or a
 *      textarea is drawn as text, a textarea's with its line breaks (see the
 *      function). Runs before step 4, so a value too long for its box gets
 *      the ellipsis.
 *
 * Steps 3 to 5 change only the clone html2canvas draws, never the page, and neither
 * can fail an export: an error in a step leaves the clone as it was before
 * that step, except for the writes the step made before the error.
 */

/** The ellipsis character an export writes where the page cuts text short. */
export const ELLIPSIS = '\u2026';

/** The rule the clone gets so its text takes the widths the canvas draws it with. */
export const NUMERIC_GLYPHS_RULE =
    '*, *::before, *::after { font-variant-numeric: normal !important; font-feature-settings: normal !important; }';

/** Lay the clone's digits out at the widths canvas text draws them with. Never throws. */
export const normalizeNumericGlyphsInClone = (clonedDoc: Document): void => {
    try {
        const style = clonedDoc.createElement('style');
        style.setAttribute('data-logserv-export', 'numeric-glyphs');
        style.textContent = NUMERIC_GLYPHS_RULE;
        (clonedDoc.head || clonedDoc.documentElement).appendChild(style);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[exportCapture] numeric rule not applied; the export draws as before', err);
    }
};

/** What the clone says about one element that holds only text. */
export interface CutProbe {
    lineClamp: string;
    textOverflow: string;
    overflowX: string;
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
}

/**
 * How the page cuts this element's text short, if it does: 'clamp' for a
 * one-line -webkit-line-clamp whose text runs past its box, 'ellipsis' for
 * text-overflow: ellipsis on a box that clips and is overflowed, otherwise
 * null. One pixel of rounding is allowed.
 */
export const cutKind = (p: CutProbe): 'clamp' | 'ellipsis' | null => {
    if (p.lineClamp.trim() === '1') {
        return p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1 ? 'clamp' : null;
    }
    const ellipsis = p.textOverflow.trim().split(/\s+/).includes('ellipsis');
    if (ellipsis && p.overflowX !== 'visible') {
        return p.scrollWidth > p.clientWidth + 1 ? 'ellipsis' : null;
    }
    return null;
};

/**
 * The text an export draws for text the page cuts short: the whole text when
 * `fits` accepts it; otherwise the longest leading part, in whole code points
 * and without trailing white space, that `fits` accepts with ELLIPSIS after
 * it; ELLIPSIS alone when no part does. `fits` must accept every shorter
 * candidate when it accepts a longer one (wider text never fits where
 * narrower text does not).
 */
export const fitWithEllipsis = (text: string, fits: (candidate: string) => boolean): string => {
    if (fits(text)) {
        return text;
    }
    const chars = Array.from(text);
    const candidate = (kept: number): string => chars.slice(0, kept).join('').replace(/\s+$/, '') + ELLIPSIS;
    let best = 0;
    let lo = 1;
    let hi = chars.length - 1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (fits(candidate(mid))) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return candidate(best);
};

/**
 * Build 403 - text that always ends in ELLIPSIS: the whole text with ELLIPSIS
 * after it (trailing white space dropped) when `fits` accepts that; otherwise
 * what fitWithEllipsis returns for its cut candidates (the longest leading
 * part with ELLIPSIS after it, or ELLIPSIS alone). For a line whose raw value
 * was dropped: there the name must end in an ellipsis even when it fits whole.
 */
export const cutWithEllipsis = (text: string, fits: (candidate: string) => boolean): string => {
    const whole = text.replace(/\s+$/, '') + ELLIPSIS;
    if (fits(whole)) {
        return whole;
    }
    return fitWithEllipsis(text, (candidate) => candidate.endsWith(ELLIPSIS) && fits(candidate));
};

/**
 * Build 403 - the texts an export draws for a line of two parts cut as ONE
 * string at its right end (components/HostName.tsx's text layer, marked
 * data-export-line): the name, then after `gap` pixels the raw value. As the
 * browser cuts that run on screen (it drops characters from the end until the
 * kept text and an ellipsis fit): both whole when they fit in `room` (half a
 * pixel of tolerance); else the name whole and the longest leading part of the
 * raw value, at least one character, with ELLIPSIS after it; else no raw value
 * and the name with ELLIPSIS after it, cut when it must (cutWithEllipsis). So
 * every cut line ends in an ellipsis and a raw value shows only beside the
 * whole name. An empty raw value adds no gap. `nameWidth` and `rawWidth`
 * measure a text in each part's font and must grow with the text.
 */
export const fitLine = (
    name: string,
    raw: string,
    gap: number,
    room: number,
    nameWidth: (text: string) => number,
    rawWidth: (text: string) => number,
): { name: string; raw: string } => {
    const limit = room + 0.5;
    const nameW = nameWidth(name);
    if (raw === '' ? nameW <= limit : nameW + gap + rawWidth(raw) <= limit) {
        return { name, raw };
    }
    if (raw !== '') {
        const cutRaw = fitWithEllipsis(raw, (candidate) => nameW + gap + rawWidth(candidate) <= limit);
        if (cutRaw !== ELLIPSIS) {
            return { name, raw: cutRaw };
        }
    }
    return { name: cutWithEllipsis(name, (candidate) => nameWidth(candidate) <= limit), raw: '' };
};

/* The font properties the measuring span copies from each element. */
const MEASURED_FONT_PROPS = [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'font-family',
    'font-feature-settings',
    'font-kerning',
    'letter-spacing',
    'word-spacing',
    'text-transform',
];

/** The computed values layoutBorderBoxWidth reads. */
export interface WidthProbe {
    width: string;
    boxSizing: string;
    paddingLeft: string;
    paddingRight: string;
    borderLeftWidth: string;
    borderRightWidth: string;
    offsetWidth: number;
}

/**
 * An element's border-box width as layout gives it, before any transform: the
 * computed width (plus padding and border for a content-box), or offsetWidth
 * when the computed width is not a length (an inline box). Not
 * getBoundingClientRect, which scales with the ancestors' transforms (the
 * topology's zoom) while html2canvas lays the clone out without them.
 */
export const layoutBorderBoxWidth = (p: WidthProbe): number => {
    const w = parseFloat(p.width);
    if (!Number.isFinite(w)) {
        return p.offsetWidth;
    }
    if (p.boxSizing === 'border-box') {
        return w;
    }
    const px = (v: string): number => parseFloat(v) || 0;
    return w + px(p.paddingLeft) + px(p.paddingRight) + px(p.borderLeftWidth) + px(p.borderRightWidth);
};

/** How an export draws a form field's text: a text box on one line, a textarea on several, or as html2canvas does. */
export const formTextKind = (tagName: string, type: string | null | undefined): 'line' | 'area' | null => {
    const tag = (tagName || '').toLowerCase();
    if (tag === 'textarea') {
        return 'area';
    }
    if (tag !== 'input') {
        return null;
    }
    const t = (type || 'text').toLowerCase();
    return ['text', 'search', 'url', 'tel', 'email', 'number'].indexOf(t) !== -1 ? 'line' : null;
};

/** The computed styles a field's stand-in takes over as they are. */
const FORM_BOX_PROPS = [
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
    'background-color',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'text-align',
    'vertical-align',
    'align-self',
    'order',
];

/* The work of replaceFormTextInClone (below), which catches its errors. */
const replaceFormText = (clonedDoc: Document): number => {
    const view = clonedDoc.defaultView;
    const { body } = clonedDoc;
    if (!view || !body) {
        return 0;
    }
    const px = (v: string): number => parseFloat(v) || 0;
    // Read everything first, then write: one layout of the clone.
    const found: Array<{ el: HTMLElement; kind: 'line' | 'area'; text: string; styles: Array<[string, string]> }> = [];
    Array.from(body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).forEach((el) => {
        const kind = formTextKind(el.tagName, el.getAttribute('type'));
        if (!kind || !el.parentNode) {
            return;
        }
        const cs = view.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
            return;
        }
        const value = typeof el.value === 'string' ? el.value : '';
        const placeholder = value === '' ? el.getAttribute('placeholder') || '' : '';
        let color = cs.color;
        if (placeholder !== '') {
            const pc = view.getComputedStyle(el, '::placeholder').color;
            color = pc || color;
        }
        const styles: Array<[string, string]> = [];
        FORM_BOX_PROPS.concat(MEASURED_FONT_PROPS).forEach((prop) => {
            styles.push([prop, cs.getPropertyValue(prop)]);
        });
        const contentH =
            el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
        styles.push(['color', color]);
        styles.push(['box-sizing', 'border-box']);
        styles.push(['width', `${el.offsetWidth}px`]);
        styles.push(['min-width', '0']);
        styles.push(['max-width', `${el.offsetWidth}px`]);
        styles.push(['height', `${el.offsetHeight}px`]);
        styles.push(['flex', '0 0 auto']);
        styles.push(['overflow', 'hidden']);
        styles.push(['display', cs.display === 'block' || cs.display === 'flex' ? 'block' : 'inline-block']);
        if (kind === 'line') {
            // One line, in the middle of the box as a text box draws it; text too long for the box takes the
            // ellipsis step's real ellipsis (text-overflow on a clipping box).
            styles.push(['white-space', 'pre']);
            styles.push(['text-overflow', 'ellipsis']);
            styles.push(['line-height', `${contentH > 0 ? contentH : px(cs.fontSize) * 1.2}px`]);
        } else {
            styles.push(['white-space', 'pre-wrap']);
            styles.push(['overflow-wrap', 'break-word']);
            styles.push(['line-height', cs.lineHeight]);
        }
        found.push({ el, kind, text: value !== '' ? value : placeholder, styles });
    });
    found.forEach((f) => {
        const box = clonedDoc.createElement('div');
        box.setAttribute('data-logserv-export', f.kind === 'line' ? 'form-line' : 'form-area');
        f.styles.forEach(([prop, value]) => box.style.setProperty(prop, value));
        box.textContent = f.text;
        const parent = f.el.parentNode;
        if (parent) {
            parent.replaceChild(box, f.el);
        }
    });
    return found.length;
};

/**
 * Draw what is typed in the clone's text boxes as text (build 406). html2canvas paints a form field's value itself,
 * on one line: a textarea's lines ran together and stopped at the right edge of the box (the Host Names paste box
 * showed its first line and a half), and a text box's value too long for its box ended with no ellipsis. Each text
 * box (text, search, url, tel, email, number) and textarea in the clone is replaced by a box of the same size,
 * border, padding, background and font that holds the value as text: a text box's on one line (the ellipsis step
 * then cuts it with a real ellipsis), a textarea's with its line breaks, wrapped, cut at the bottom of the box. An
 * empty field shows its placeholder in the placeholder colour. Password fields, checkboxes, radio buttons and
 * selects stay as html2canvas draws them. Runs before ellipsizeCutTextInClone. Returns how many fields it replaced.
 * Never throws: on an error it stops and returns 0, and the export draws the remaining fields as before.
 */
export const replaceFormTextInClone = (clonedDoc: Document): number => {
    try {
        return replaceFormText(clonedDoc);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[exportCapture] form text not replaced; the export draws the fields as before', err);
        return 0;
    }
};

/* The work of ellipsizeCutTextInClone (below), which catches its errors. */
const ellipsizeCutText = (clonedDoc: Document): number => {
    const view = clonedDoc.defaultView;
    const { body } = clonedDoc;
    if (!view || !body) {
        return 0;
    }
    const fontOf = (cs: CSSStyleDeclaration): Array<[string, string]> =>
        MEASURED_FONT_PROPS.map((prop): [string, string] => [prop, cs.getPropertyValue(prop)]);
    // Build 403: the two-part lines first (components/HostName.tsx). Their parts are cut as one string below and
    // are never treated as leaves of their own.
    const lines: Array<{
        nameEl: HTMLElement;
        rawEl: HTMLElement;
        name: string;
        raw: string;
        gap: number;
        room: number;
        nameFont: Array<[string, string]>;
        rawFont: Array<[string, string]>;
    }> = [];
    const inLine = new Set<Element>();
    Array.from(body.querySelectorAll<HTMLElement>('[data-export-line]')).forEach((el) => {
        const nameEl = el.querySelector<HTMLElement>('[data-export-part="name"]');
        const rawEl = el.querySelector<HTMLElement>('[data-export-part="raw"]');
        if (!nameEl || !rawEl) {
            return;
        }
        inLine.add(nameEl);
        inLine.add(rawEl);
        const cs = view.getComputedStyle(el);
        if (cs.overflowX === 'visible' || el.scrollWidth <= el.clientWidth + 1) {
            return;
        }
        const rawCs = view.getComputedStyle(rawEl);
        lines.push({
            nameEl,
            rawEl,
            name: (nameEl.textContent || '').replace(/\s+/g, ' ').trim(),
            raw: (rawEl.textContent || '').replace(/\s+/g, ' ').trim(),
            gap: parseFloat(rawCs.marginLeft) || 0,
            room: el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0),
            nameFont: fontOf(view.getComputedStyle(nameEl)),
            rawFont: fontOf(rawCs),
        });
    });
    const found: Array<{
        el: HTMLElement;
        kind: 'clamp' | 'ellipsis';
        text: string;
        width: number;
        room: number;
        font: Array<[string, string]>;
    }> = [];
    Array.from(body.querySelectorAll<HTMLElement>('*')).forEach((el) => {
        if (el.childElementCount !== 0 || inLine.has(el)) {
            return;
        }
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            return;
        }
        const cs = view.getComputedStyle(el);
        // A hidden element is not drawn (HostName.tsx's sizer, for one).
        if (cs.visibility === 'hidden') {
            return;
        }
        const kind = cutKind({
            lineClamp: cs.getPropertyValue('-webkit-line-clamp') || 'none',
            textOverflow: cs.textOverflow || '',
            overflowX: cs.overflowX || '',
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        });
        if (!kind) {
            return;
        }
        const room =
            el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        found.push({
            el,
            kind,
            text,
            width: layoutBorderBoxWidth({
                width: cs.width,
                boxSizing: cs.boxSizing,
                paddingLeft: cs.paddingLeft,
                paddingRight: cs.paddingRight,
                borderLeftWidth: cs.borderLeftWidth,
                borderRightWidth: cs.borderRightWidth,
                offsetWidth: el.offsetWidth,
            }),
            room,
            font: fontOf(cs),
        });
    });
    if (found.length === 0 && lines.length === 0) {
        return 0;
    }

    const measurer = clonedDoc.createElement('span');
    measurer.setAttribute('data-logserv-export', 'measure');
    measurer.style.position = 'absolute';
    measurer.style.left = '-100000px';
    measurer.style.top = '0';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.padding = '0';
    measurer.style.border = '0';
    body.appendChild(measurer);
    const widthIn = (font: Array<[string, string]>, text: string): number => {
        font.forEach(([prop, value]) => measurer.style.setProperty(prop, value));
        measurer.textContent = text;
        return measurer.getBoundingClientRect().width;
    };
    let fitted: string[];
    let fittedLines: Array<{ name: string; raw: string }>;
    try {
        fitted = found.map((f) => fitWithEllipsis(f.text, (candidate) => widthIn(f.font, candidate) <= f.room + 0.5));
        fittedLines = lines.map((l) =>
            fitLine(l.name, l.raw, l.gap, l.room, (t) => widthIn(l.nameFont, t), (t) => widthIn(l.rawFont, t)),
        );
    } finally {
        body.removeChild(measurer);
    }

    found.forEach((f, i) => {
        const { el } = f;
        const s = el.style;
        s.boxSizing = 'border-box';
        s.width = `${f.width}px`;
        s.maxWidth = `${f.width}px`;
        s.minWidth = '0';
        s.flex = '0 0 auto';
        if (f.kind === 'clamp') {
            s.display = 'block';
            s.setProperty('-webkit-line-clamp', 'none');
        }
        s.whiteSpace = 'nowrap';
        s.overflow = 'hidden';
        el.textContent = fitted[i];
    });
    lines.forEach((l, i) => {
        const { nameEl, rawEl } = l;
        nameEl.textContent = fittedLines[i].name;
        rawEl.textContent = fittedLines[i].raw;
        if (fittedLines[i].raw === '') {
            rawEl.style.marginLeft = '0';
        }
    });
    return found.length + lines.length;
};

/**
 * Give every text the clone cuts short a real ellipsis (see above). Reads the
 * whole clone first, measures each candidate in one off-screen span (so the
 * page itself is laid out again only once), then writes: the element keeps
 * the layout width it has, stays on one line, and holds the text
 * fitWithEllipsis returns. Only elements with no child elements are touched,
 * and none that is hidden. Build 403: a line marked data-export-line (the
 * name and raw value of components/HostName.tsx) that the clone cuts is cut
 * as one string by fitLine, its two parts' texts written in place; its parts
 * are never treated on their own. Returns how many it changed (elements and
 * lines). Never throws: on an error it stops (its measuring span removed)
 * and returns 0, and the export draws the rest as before.
 */
export const ellipsizeCutTextInClone = (clonedDoc: Document): number => {
    try {
        return ellipsizeCutText(clonedDoc);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[exportCapture] cut text not ellipsized; the export draws it as before', err);
        return 0;
    }
};
