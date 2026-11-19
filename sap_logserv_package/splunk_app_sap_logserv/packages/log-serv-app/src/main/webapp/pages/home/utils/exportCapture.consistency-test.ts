/**
 * Build-time consistency test for what Download PNG / Download PDF do to the
 * page copy html2canvas draws (utils/exportCapture.ts, build 402).
 *
 * html2canvas 1.4.1 places each word where the copy's layout puts it but
 * draws it with canvas text, which knows neither font-variant-numeric nor
 * -webkit-line-clamp / text-overflow: ellipsis. Build 401's exports drew the
 * Host Names list's times as "2026-11 -17 17 :10" and a host name cut short
 * in a narrow column as its first word alone ("Reporting" for "Reporting
 * Server"), with no ellipsis.
 *
 * What it pins:
 *  - X1: fitWithEllipsis keeps text that fits whole, and otherwise returns
 *    exactly what a brute-force search returns: the longest leading part (whole
 *    code points, trailing white space dropped) that fits with the ellipsis,
 *    or the ellipsis alone;
 *  - X2: it never splits a surrogate pair and never leaves white space before
 *    the ellipsis;
 *  - X3: cutKind: a one-line clamp overflowed in height or width is 'clamp',
 *    text-overflow: ellipsis on a clipping box overflowed in width is
 *    'ellipsis', one pixel of rounding is not a cut but two are, and a clamp
 *    of more than one line, a visible overflow and text-overflow: clip are
 *    left alone;
 *  - X4: NUMERIC_GLYPHS_RULE sets font-variant-numeric: normal and
 *    font-feature-settings: normal, both !important, on every element and
 *    pseudo-element; normalizeNumericGlyphsInClone adds it to the copy as a
 *    style element and never throws;
 *  - X5a: layoutBorderBoxWidth: the computed width, plus padding and border
 *    for a content-box, offsetWidth when the width is not a length;
 *  - X5: ellipsizeCutTextInClone, on a fake copy whose bounding rectangles are
 *    0.4 times the layout (a zoomed-out topology): changes only elements with
 *    no child elements whose text is cut, measures each with that element's
 *    font-size, letter-spacing and text-transform, keeps each one's LAYOUT
 *    width (never the bounding rectangle) and puts it on one line (a clamp
 *    also becomes a plain block with no clamp), writes the text fitWithEllipsis
 *    returns for the element's room (both paddings off, half a pixel of
 *    tolerance), removes its measuring span, returns the count, does nothing
 *    without a window, and never throws (a failed read or measure returns 0,
 *    removes the span and writes nothing);
 *  - X6: ActionsDropdown's onclone is exactly freezeAnimationsInClone, the
 *    topology svg raster swap, normalizeNumericGlyphsInClone and
 *    ellipsizeCutTextInClone, in that order, as bare statements;
 *  - X7: every -webkit-line-clamp in the app's source is a one-line clamp (the
 *    only kind the export handles), and HostName's (sizer) name still uses one;
 *  - X8 (build 403): fitLine, the cut of HostName's one-run line, equals an
 *    independent reference (the drawings a browser can make, in the order it
 *    prefers them) over names, raw values, gaps and quarter-pixel rooms, with
 *    the two parts measured in different fractional widths; every cut line
 *    ends in an ellipsis and a raw value shows only beside the whole name (the
 *    band where the name fits whole but no raw character does included); the
 *    half-pixel tolerance; cutWithEllipsis equals its reference;
 *  - X9 (build 403): on a fake copy, a cut line marked data-export-line gets
 *    fitLine's texts in its two parts, each part measured in its own font,
 *    white space collapsed, padding off the room (a dropped raw value loses its
 *    gap), and a line that fits or overflows by one pixel, a line that does not
 *    clip, a line without its parts, the parts themselves (even when they look
 *    cut) and a hidden element are left alone; the measuring span measures
 *    only while it is in the body.
 */
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');
const xc = require('./exportCapture');

const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let xFailures = 0;
let xChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    xChecks += 1;
    if (!ok) {
        xFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

const E = xc.ELLIPSIS;
check('X0 ellipsis', E === '\u2026', `ELLIPSIS is ${JSON.stringify(E)}`);

// Widths for the fake measure: a space 4, the ellipsis 10, a lone surrogate
// (half of a split pair, drawn as a narrow replacement glyph) 6, a CJK or
// astral character 14, a capital letter 9, anything else 7.
const charW = (ch: string): number => {
    const code = ch.codePointAt(0)!;
    if (ch === ' ') return 4;
    if (ch === E) return 10;
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) return 6;
    if (code > 0x2e80) return 14;
    if (code >= 0x41 && code <= 0x5a) return 9;
    return 7;
};
const widthOf = (s: string): number => Array.from(s).reduce((a: number, c: string) => a + charW(c), 0);

// X1: whole text, then brute force over many strings and room sizes.
const brute = (text: string, room: number): string => {
    if (widthOf(text) <= room) return text;
    const chars = Array.from(text);
    for (let k = chars.length - 1; k >= 1; k -= 1) {
        const c = chars.slice(0, k).join('').replace(/\s+$/, '') + E;
        if (widthOf(c) <= room) return c;
    }
    return E;
};
const SAMPLES = [
    'Reporting Server',
    'Finance App',
    'Payroll DB',
    'a',
    'ab',
    '   ',
    'Batch Server 08 with a much longer name than the column',
    'hec53v037146.sin.hec.xsd-vlab.com',
    'name \u{1F600} with an emoji \u{1F680} inside',
    '\u65e5\u672c\u8a9e\u306e\u540d\u524d',
    'trailing   spaces   ',
];
let x1Bad = '';
SAMPLES.forEach((t: string) => {
    for (let room = 0; room <= widthOf(t) + 12; room += 1) {
        const got = xc.fitWithEllipsis(t, (c: string) => widthOf(c) <= room);
        const want = brute(t, room);
        if (got !== want && !x1Bad) x1Bad = `${JSON.stringify(t)} room ${room}: ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
    }
});
check('X1 brute force', x1Bad === '', x1Bad);
check('X1 whole', xc.fitWithEllipsis('Finance App', () => true) === 'Finance App', 'text that fits is changed');
check('X1 nothing fits', xc.fitWithEllipsis('Finance App', () => false) === E, 'no part fits but not the ellipsis alone');
let calls = 0;
xc.fitWithEllipsis('x'.repeat(1000), (c: string) => {
    calls += 1;
    return c.length <= 300;
});
check('X1 binary search', calls <= 13, `${calls} measurements for 1000 characters`);

// X2
let x2Bad = '';
SAMPLES.forEach((t: string) => {
    for (let room = 0; room <= widthOf(t); room += 3) {
        const got: string = xc.fitWithEllipsis(t, (c: string) => widthOf(c) <= room);
        if (!got.endsWith(E)) continue;
        const body = got.slice(0, -1);
        if (/\s$/.test(body) && !x2Bad) x2Bad = `space before the ellipsis: ${JSON.stringify(got)}`;
        if (/[\ud800-\udbff]$/.test(body) && !x2Bad) x2Bad = `lone high surrogate: ${JSON.stringify(got)}`;
        if (!t.startsWith(body) && !x2Bad) x2Bad = `not a leading part: ${JSON.stringify(got)} of ${JSON.stringify(t)}`;
    }
});
check('X2 code points and spaces', x2Bad === '', x2Bad);

// X3
const probe = (o: any): any => ({
    lineClamp: 'none',
    textOverflow: 'clip',
    overflowX: 'visible',
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 20,
    clientHeight: 20,
    ...o,
});
const kinds: Array<[string, any, any]> = [
    ['clamp height', { lineClamp: '1', overflowX: 'hidden', scrollHeight: 40 }, 'clamp'],
    ['clamp width', { lineClamp: '1', overflowX: 'hidden', scrollWidth: 120 }, 'clamp'],
    ['clamp fits', { lineClamp: '1', overflowX: 'hidden' }, null],
    ['clamp rounding', { lineClamp: '1', overflowX: 'hidden', scrollHeight: 21, scrollWidth: 101 }, null],
    ['clamp 2px height', { lineClamp: '1', overflowX: 'hidden', scrollHeight: 22 }, 'clamp'],
    ['clamp 2px width', { lineClamp: '1', overflowX: 'hidden', scrollWidth: 102 }, 'clamp'],
    ['clamp two lines', { lineClamp: '2', overflowX: 'hidden', scrollHeight: 60 }, null],
    ['ellipsis cut', { textOverflow: 'ellipsis', overflowX: 'hidden', scrollWidth: 140 }, 'ellipsis'],
    ['ellipsis clip value', { textOverflow: 'ellipsis', overflowX: 'clip', scrollWidth: 140 }, 'ellipsis'],
    ['ellipsis two values', { textOverflow: 'clip ellipsis', overflowX: 'hidden', scrollWidth: 140 }, 'ellipsis'],
    ['ellipsis fits', { textOverflow: 'ellipsis', overflowX: 'hidden', scrollWidth: 101 }, null],
    ['ellipsis 2px', { textOverflow: 'ellipsis', overflowX: 'hidden', scrollWidth: 102 }, 'ellipsis'],
    ['ellipsis height only', { textOverflow: 'ellipsis', overflowX: 'hidden', scrollHeight: 60 }, null],
    ['ellipsis visible', { textOverflow: 'ellipsis', overflowX: 'visible', scrollWidth: 140 }, null],
    ['clip', { textOverflow: 'clip', overflowX: 'hidden', scrollWidth: 140 }, null],
    ['nothing', { scrollWidth: 140, scrollHeight: 60 }, null],
];
kinds.forEach(([label, o, want]: [string, any, any]) => {
    const got = xc.cutKind(probe(o));
    check(`X3 ${label}`, got === want, `cutKind ${JSON.stringify(o)} = ${got}, want ${want}`);
});

// X4
const rule: string = xc.NUMERIC_GLYPHS_RULE;
check('X4 rule', /^\*, \*::before, \*::after \{\s*font-variant-numeric: normal !important;\s*font-feature-settings: normal !important;\s*\}$/.test(rule),
    `NUMERIC_GLYPHS_RULE is ${JSON.stringify(rule)}`);
// The clone steps warn on the console when they fail; these checks fail them
// on purpose, so their warnings are counted here instead of printed.
let warnings = 0;
const realWarn = console.warn;
const quiet = (): void => { console.warn = () => { warnings += 1; }; };
const loud = (): void => { console.warn = realWarn; };
let x4Threw = '';
quiet();
try {
    xc.normalizeNumericGlyphsInClone({ createElement: () => { throw new Error('boom'); } });
} catch (err) {
    x4Threw = String(err);
}
loud();
check('X4 warns', warnings === 1, `${warnings} warnings, want 1`);
check('X4 never throws', x4Threw === '', `normalizeNumericGlyphsInClone threw ${x4Threw}`);
const added: any[] = [];
const fakeHeadDoc: any = {
    createElement: (tag: string) => ({ tag, attrs: {} as any, setAttribute(k: string, v: string) { this.attrs[k] = v; }, textContent: '' }),
    head: { appendChild: (n: any) => added.push(n) },
};
xc.normalizeNumericGlyphsInClone(fakeHeadDoc);
check('X4 style added', added.length === 1 && added[0].tag === 'style' && added[0].textContent === rule
    && added[0].attrs['data-logserv-export'] === 'numeric-glyphs', `added ${JSON.stringify(added)}`);

// X5a: layoutBorderBoxWidth.
const wp = (o: any): any => ({
    width: '100px',
    boxSizing: 'content-box',
    paddingLeft: '0px',
    paddingRight: '0px',
    borderLeftWidth: '0px',
    borderRightWidth: '0px',
    offsetWidth: 0,
    ...o,
});
const widths: Array<[string, any, number]> = [
    ['content-box', { width: '142px', paddingLeft: '2px', paddingRight: '6px', borderLeftWidth: '1px', borderRightWidth: '1px' }, 152],
    ['border-box', { width: '154px', boxSizing: 'border-box', paddingLeft: '2px', paddingRight: '6px', borderLeftWidth: '1px' }, 154],
    ['fractional', { width: '87.5px' }, 87.5],
    ['auto', { width: 'auto', paddingLeft: '2px', offsetWidth: 70 }, 70],
];
widths.forEach(([label, o, want]: [string, any, number]) => {
    const got = xc.layoutBorderBoxWidth(wp(o));
    check(`X5a ${label}`, got === want, `layoutBorderBoxWidth ${JSON.stringify(o)} = ${got}, want ${want}`);
});

// X5: a fake copy. Elements report their own layout box, and a bounding
// rectangle 0.4 times as wide (a zoomed-out ancestor, as on the topology);
// the measuring span reports the fake width of its text under the copied
// font-size, letter-spacing and text-transform.
const fakeStyle = (): any => {
    const s: any = { props: {} as any };
    s.setProperty = (k: string, v: string) => { s.props[k] = v; };
    return s;
};
const measureW = (text: string, props: any): number => {
    const t = props['text-transform'] === 'uppercase' ? text.toUpperCase() : text;
    const ls = parseFloat(props['letter-spacing'] || '0') || 0;
    return (widthOf(t) + ls * Array.from(t).length) * ((parseFloat(props['font-size'] || '14') || 14) / 14);
};
const computed = (o: any): any => {
    const c: any = {
        textOverflow: 'clip',
        overflowX: 'visible',
        paddingLeft: '0px',
        paddingRight: '0px',
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        boxSizing: 'content-box',
        width: 'auto',
        lineClamp: 'none',
        fontSize: '14px',
        letterSpacing: 'normal',
        textTransform: 'none',
        ...o,
    };
    c.getPropertyValue = (name: string): string => {
        if (name === '-webkit-line-clamp') return c.lineClamp;
        if (name === 'font-size') return c.fontSize;
        if (name === 'font-family') return 'Fake Sans';
        if (name === 'letter-spacing') return c.letterSpacing;
        if (name === 'text-transform') return c.textTransform;
        return '';
    };
    return c;
};
const leaf = (text: string, box: any, cs: any, children = 0): any => ({
    childElementCount: children,
    textContent: text,
    style: fakeStyle(),
    computed: computed(cs),
    scrollWidth: box.scrollWidth,
    clientWidth: box.clientWidth,
    scrollHeight: box.scrollHeight ?? 19,
    clientHeight: box.clientHeight ?? 19,
    offsetWidth: box.offsetWidth ?? box.clientWidth,
    getBoundingClientRect: () => ({ width: 0.4 * (box.offsetWidth ?? box.clientWidth) }),
});
const ELL = { textOverflow: 'ellipsis', overflowX: 'hidden' };
const clampEl = leaf('  Reporting   Server ', { scrollWidth: 88, clientWidth: 88, scrollHeight: 38 },
    { lineClamp: '1', overflowX: 'hidden', width: '88px' });
const fitsEl = leaf('Payroll DB', { scrollWidth: 59, clientWidth: 59 }, { lineClamp: '1', overflowX: 'hidden', width: '59px' });
const ellEl = leaf('hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 260, clientWidth: 150, offsetWidth: 152 },
    { ...ELL, width: '142px', paddingLeft: '2px', paddingRight: '6px', borderLeftWidth: '1px', borderRightWidth: '1px' });
const bigEl = leaf('hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 520, clientWidth: 150 },
    { ...ELL, width: '154px', boxSizing: 'border-box', paddingLeft: '2px', paddingRight: '6px', fontSize: '28px' });
const upperEl = leaf('hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 300, clientWidth: 150 },
    { ...ELL, width: '150px', textTransform: 'uppercase', letterSpacing: '1px' });
const tolEl = leaf('Payroll', { scrollWidth: 53, clientWidth: 51 }, { ...ELL, width: '51px', letterSpacing: '0.05px' });
const autoEl = leaf('Finance App Server', { scrollWidth: 140, clientWidth: 70, offsetWidth: 70 }, { ...ELL, width: 'auto' });
const parentEl = leaf('Finance App hec53v020510', { scrollWidth: 300, clientWidth: 100 }, { ...ELL, width: '100px' }, 1);
const emptyEl = leaf('   ', { scrollWidth: 300, clientWidth: 100 }, { ...ELL, width: '100px' });
const visEl = leaf('hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 300, clientWidth: 100 },
    { textOverflow: 'ellipsis', overflowX: 'visible', width: '100px' });
const all = [clampEl, fitsEl, ellEl, bigEl, upperEl, tolEl, autoEl, parentEl, emptyEl, visEl];
const bodyKids: any[] = [];
let measurerSeen: any = null;
let measureThrows = false;
const fakeDoc: any = {
    defaultView: { getComputedStyle: (el: any) => el.computed },
    body: {
        querySelectorAll: (sel: string) => (sel === '[data-export-line]' ? [] : all),
        appendChild: (n: any) => { bodyKids.push(n); measurerSeen = n; },
        removeChild: (n: any) => { bodyKids.splice(bodyKids.indexOf(n), 1); },
    },
    createElement: (tag: string) => {
        const m: any = { tag, attrs: {} as any, style: fakeStyle(), textContent: '' };
        m.setAttribute = (k: string, v: string) => { m.attrs[k] = v; };
        // A detached element has no layout: the span measures only while it is in the body.
        m.getBoundingClientRect = () => {
            if (measureThrows) throw new Error('measure failed');
            return { width: bodyKids.includes(m) ? measureW(m.textContent, m.style.props) : 0 };
        };
        return m;
    },
};
const before = all.map((e: any) => e.textContent);
const n = xc.ellipsizeCutTextInClone(fakeDoc);
check('X5 count', n === 6, `changed ${n}, want 6 (the clamp and five ellipsis leaves)`);
const fitAt = (text: string, room: number, props: any): string =>
    xc.fitWithEllipsis(text, (c: string) => measureW(c, props) <= room + 0.5);
const P14 = { 'font-size': '14px' };
check('X5 clamp text', clampEl.textContent === fitAt('Reporting Server', 88, P14),
    `clamp text ${JSON.stringify(clampEl.textContent)}, want ${JSON.stringify(fitAt('Reporting Server', 88, P14))}`);
check('X5 clamp cut', clampEl.textContent.endsWith(E) && clampEl.textContent.startsWith('Reporting'),
    `clamp text ${JSON.stringify(clampEl.textContent)}`);
check('X5 clamp style', clampEl.style.display === 'block' && clampEl.style.props['-webkit-line-clamp'] === 'none'
    && clampEl.style.whiteSpace === 'nowrap' && clampEl.style.overflow === 'hidden' && clampEl.style.width === '88px'
    && clampEl.style.maxWidth === '88px' && clampEl.style.minWidth === '0' && clampEl.style.flex === '0 0 auto'
    && clampEl.style.boxSizing === 'border-box', `clamp style ${JSON.stringify(clampEl.style)}`);
check('X5 ellipsis text', ellEl.textContent === fitAt(before[2], 142, P14),
    `ellipsis text ${JSON.stringify(ellEl.textContent)}, want ${JSON.stringify(fitAt(before[2], 142, P14))} (room 150 - 2 - 6)`);
check('X5 layout width', ellEl.style.width === '152px' && ellEl.style.maxWidth === '152px' && bigEl.style.width === '154px'
    && autoEl.style.width === '70px', `widths ${ellEl.style.width} ${bigEl.style.width} ${autoEl.style.width}, want the layout`
    + ' widths 152px 154px 70px, never the 0.4x bounding rectangle');
check('X5 ellipsis style', ellEl.style.display === undefined && ellEl.style.props['-webkit-line-clamp'] === undefined
    && ellEl.style.whiteSpace === 'nowrap', `ellipsis style ${JSON.stringify(ellEl.style)}`);
check('X5 font-size copied', bigEl.textContent === fitAt(before[3], 142, { 'font-size': '28px' })
    && Array.from(bigEl.textContent as string).length < Array.from(ellEl.textContent as string).length,
    `28px text ${JSON.stringify(bigEl.textContent)} vs 14px ${JSON.stringify(ellEl.textContent)}`);
const upperProps = { 'font-size': '14px', 'text-transform': 'uppercase', 'letter-spacing': '1px' };
check('X5 text-transform and letter-spacing copied', upperEl.textContent === fitAt(before[4], 150, upperProps)
    && upperEl.textContent !== fitAt(before[4], 150, P14), `uppercase text ${JSON.stringify(upperEl.textContent)}`);
check('X5 tolerance', tolEl.textContent === 'Payroll', `${JSON.stringify(tolEl.textContent)}: text half a pixel too wide is kept whole`);
check('X5 untouched', fitsEl.textContent === before[1] && Object.keys(fitsEl.style.props).length === 0
    && fitsEl.style.whiteSpace === undefined && parentEl.textContent === before[7] && parentEl.style.whiteSpace === undefined
    && emptyEl.textContent === before[8] && emptyEl.style.whiteSpace === undefined
    && visEl.textContent === before[9] && visEl.style.whiteSpace === undefined,
    'an element that fits, has a child element, holds only white space or does not clip was changed');
check('X5 measurer', measurerSeen && measurerSeen.tag === 'span' && measurerSeen.attrs['data-logserv-export'] === 'measure'
    && measurerSeen.style.visibility === 'hidden' && measurerSeen.style.whiteSpace === 'nowrap'
    && measurerSeen.style.position === 'absolute' && bodyKids.length === 0,
    `measuring span ${JSON.stringify(measurerSeen)}, left in body: ${bodyKids.length}`);
check('X5 no window', xc.ellipsizeCutTextInClone({ defaultView: null, body: fakeDoc.body }) === 0
    && xc.ellipsizeCutTextInClone({ defaultView: fakeDoc.defaultView, body: null }) === 0, 'ran without a window or body');
// Never throws: a failed read, and a failed measure (the span still removed, nothing written).
let x5Threw = '';
let r1 = -1;
let r2 = -1;
const fresh = leaf('hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 260, clientWidth: 150 }, { ...ELL, width: '150px' });
warnings = 0;
quiet();
try {
    r1 = xc.ellipsizeCutTextInClone({ defaultView: fakeDoc.defaultView, body: { querySelectorAll: () => { throw new Error('read'); } } });
    measureThrows = true;
    bodyKids.length = 0;
    r2 = xc.ellipsizeCutTextInClone({ ...fakeDoc, body: { ...fakeDoc.body,
        querySelectorAll: (sel: string) => (sel === '[data-export-line]' ? [] : [fresh]) } });
} catch (err) {
    x5Threw = String(err);
}
measureThrows = false;
loud();
check('X5 warns', warnings === 2, `${warnings} warnings, want 2`);
check('X5 never throws', x5Threw === '' && r1 === 0 && r2 === 0 && bodyKids.length === 0
    && fresh.textContent === 'hec53v037146.sin.hec.xsd-vlab.com' && fresh.style.whiteSpace === undefined,
    `threw ${x5Threw}, returned ${r1} / ${r2}, span left ${bodyKids.length}, text ${JSON.stringify(fresh.textContent)}`);

// X8 (build 403): fitLine against an independent reference (the drawings a browser can make, in the order it prefers
// them), cutWithEllipsis against its own, and the user's rule on every cut line: it ends in an ellipsis, and a raw value
// shows only beside the whole name. The name and the raw value are measured in different, fractional widths.
const rawWidthOf = (t: string): number => widthOf(t) * 1.25 + 0.3;
const leadingParts = (t: string): string[] => {
    const ch = Array.from(t);
    const out: string[] = [];
    for (let k = ch.length - 1; k >= 1; k -= 1) out.push(ch.slice(0, k).join('').replace(/\s+$/, ''));
    return out;
};
const refCut = (t: string, limit: number, w: (s: string) => number): string => {
    if (w(t.replace(/\s+$/, '') + E) <= limit) return t.replace(/\s+$/, '') + E;
    for (const p of leadingParts(t)) if (w(p + E) <= limit) return p + E;
    return E;
};
const refLine = (nm: string, rw: string, gap: number, room: number): { name: string; raw: string } => {
    const limit = room + 0.5;
    if (rw === '' ? widthOf(nm) <= limit : widthOf(nm) + gap + rawWidthOf(rw) <= limit) return { name: nm, raw: rw };
    if (rw !== '') {
        for (const p of leadingParts(rw)) {
            if (p !== '' && widthOf(nm) + gap + rawWidthOf(p + E) <= limit) return { name: nm, raw: p + E };
        }
    }
    return { name: refCut(nm, limit, widthOf), raw: '' };
};
const LINES: Array<[string, string]> = [
    ['Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com'],
    ['Finance App', '10.1.2.3'],
    ['Payroll and HR production application server cluster node A', 'hec53v020510'],
    ['a', 'b'],
    ['Payroll DB', 'h'],
    ['Router Gateway', ''],
    ['name with  spaces  ', 'raw  with  spaces'],
];
let x8Bad = '';
let x8Rule = '';
let x8Band = 0;
LINES.forEach(([nm, rw]: [string, string]) => {
    [0, 6].forEach((gap: number) => {
        const top = widthOf(nm) + gap + rawWidthOf(rw) + 12;
        for (let room = 0; room <= top; room += 0.25) {
            const got = xc.fitLine(nm, rw, gap, room, widthOf, rawWidthOf);
            const want = refLine(nm, rw, gap, room);
            if ((got.name !== want.name || got.raw !== want.raw) && !x8Bad) {
                x8Bad = `${JSON.stringify([nm, rw, gap, room])}: ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
            }
            const whole = got.name === nm && got.raw === rw;
            if (!whole) {
                const ok = got.raw !== '' ? got.name === nm && got.raw.endsWith(E) : got.name.endsWith(E);
                if (!ok && !x8Rule) x8Rule = `${JSON.stringify([nm, rw, gap, room])}: ${JSON.stringify(got)}`;
                // The band where the name fits whole but no raw character does: the name must still end in the ellipsis.
                if (rw !== '' && got.raw === '' && widthOf(nm) <= room + 0.5) x8Band += 1;
            }
        }
    });
});
check('X8 fitLine reference', x8Bad === '', x8Bad);
check('X8 every cut line ends in an ellipsis; a raw value only beside the whole name', x8Rule === '', x8Rule);
check('X8 the band is exercised', x8Band > 0, 'no case where the name fits whole but no raw character does');
check('X8 fitLine whole', JSON.stringify(xc.fitLine('Payroll DB', 'hec53v014023', 6, 1000, widthOf, rawWidthOf))
    === JSON.stringify({ name: 'Payroll DB', raw: 'hec53v014023' }), 'a line that fits is changed');
// Half a pixel of tolerance, and the two parts measured each in its own font.
const nwHalf = widthOf('ab');
check('X8 tolerance', JSON.stringify(xc.fitLine('ab', '', 6, nwHalf - 0.4, widthOf, rawWidthOf)) === JSON.stringify({ name: 'ab', raw: '' })
    && xc.fitLine('ab', '', 6, nwHalf - 0.6, widthOf, rawWidthOf).name !== 'ab', 'the half-pixel tolerance');
check('X8 each part in its own font', JSON.stringify(xc.fitLine('ab', 'cd', 6, widthOf('ab') + 6 + rawWidthOf('cd'), widthOf, rawWidthOf))
    === JSON.stringify({ name: 'ab', raw: 'cd' })
    && xc.fitLine('ab', 'cd', 6, widthOf('ab') + 6 + widthOf('cd'), widthOf, rawWidthOf).raw !== 'cd',
    'the raw value measured with the name\'s width function');
let x8Cut = '';
SAMPLES.forEach((t: string) => {
    for (let room = 0; room <= widthOf(t) + 14; room += 1) {
        const got = xc.cutWithEllipsis(t, (c: string) => widthOf(c) <= room);
        const want = refCut(t, room, widthOf);
        if (got !== want && !x8Cut) x8Cut = `${JSON.stringify(t)} room ${room}: ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
    }
});
check('X8 cutWithEllipsis reference', x8Cut === '', x8Cut);

// X9 (build 403): the two-part line pass on a fake copy. A cut line gets fitLine's texts in its two parts, each part
// measured in its own font (the raw part here at 12 px), white space collapsed, the line's padding off its room; a
// dropped raw value loses its margin. A line that fits or overflows by one pixel, a line whose box does not clip, a
// line without its parts, the parts themselves (even when they look cut) and a hidden element are left alone. The
// measuring span measures only while it is in the body.
const part = (text: string, cs: any): any => ({ ...leaf(text, { scrollWidth: 400, clientWidth: 10 }, cs), kind: 'part' });
const P12 = { 'font-size': '12px' };
const mkLine = (nm: string, rw: string, box: any, cs: any = {}): any => {
    const nameP = part(nm, { lineClamp: '1', overflowX: 'hidden' });
    const rawP = part(rw, { ...ELL, marginLeft: '6px', fontSize: '12px' });
    return {
        ...leaf(`${nm} - ${rw}`, box, { overflowX: 'hidden', textOverflow: 'ellipsis', ...cs }, 3),
        nameP,
        rawP,
        querySelector: (sel: string) => (sel === '[data-export-part="name"]' ? nameP
            : sel === '[data-export-part="raw"]' ? rawP : null),
    };
};
const expectLine = (nm: string, rw: string, room: number): { name: string; raw: string } =>
    xc.fitLine(nm, rw, 6, room, (t: string) => measureW(t, P14), (t: string) => measureW(t, P12));
const cutLine = mkLine('Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 400, clientWidth: 180 });
const nameOnly = mkLine('Payroll and HR production application server', '10.1.2.3', { scrollWidth: 400, clientWidth: 120 });
const bandRoom = measureW('Payroll DB', P14) + 3;
const bandLine = mkLine('Payroll DB', 'hec53v014023', { scrollWidth: 400, clientWidth: bandRoom });
const spaced = mkLine('  Payroll   DB ', ' hec53v014023 ', { scrollWidth: 400, clientWidth: 130 });
const padded = mkLine('Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com', { scrollWidth: 400, clientWidth: 188 },
    { paddingLeft: '4px', paddingRight: '4px' });
const fitLineEl = mkLine('Payroll DB', 'hec53v014023', { scrollWidth: 160, clientWidth: 160 });
const onePx = mkLine('Payroll DB', 'hec53v014023', { scrollWidth: 161, clientWidth: 160 });
const noClip = mkLine('Payroll DB', 'hec53v014023', { scrollWidth: 400, clientWidth: 100 }, { overflowX: 'visible' });
const noParts: any = { ...leaf('x - y', { scrollWidth: 400, clientWidth: 50 }, { overflowX: 'hidden' }, 2), querySelector: () => null };
const hiddenLeaf = leaf('Reporting Server', { scrollWidth: 88, clientWidth: 88, scrollHeight: 38 },
    { lineClamp: '1', overflowX: 'hidden', width: '88px', visibility: 'hidden' });
const lineEls = [cutLine, nameOnly, bandLine, spaced, padded, fitLineEl, onePx, noClip, noParts];
const partsOf = (ls: any[]): any[] => ls.filter((l: any) => l.nameP).reduce((acc: any[], l: any) => acc.concat([l.nameP, l.rawP]), []);
const allX9 = [...lineEls, ...partsOf(lineEls), hiddenLeaf];
const x9Doc: any = { ...fakeDoc, body: { ...fakeDoc.body,
    querySelectorAll: (sel: string) => (sel === '[data-export-line]' ? lineEls : allX9) } };
const n9 = xc.ellipsizeCutTextInClone(x9Doc);
const same9 = (l: any, want: { name: string; raw: string }): boolean => l.nameP.textContent === want.name && l.rawP.textContent === want.raw;
const wCut = expectLine('Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com', 180);
const wName = expectLine('Payroll and HR production application server', '10.1.2.3', 120);
const wBand = expectLine('Payroll DB', 'hec53v014023', bandRoom);
const wSpaced = expectLine('Payroll DB', 'hec53v014023', 130);
const wPadded = expectLine('Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com', 180);
check('X9 count', n9 === 5, `changed ${n9}, want 5 (the five cut lines)`);
check('X9 cut line', same9(cutLine, wCut) && wCut.name === 'Reporting Server' && wCut.raw.endsWith(E)
    && cutLine.rawP.style.marginLeft === undefined, `parts ${JSON.stringify([cutLine.nameP.textContent, cutLine.rawP.textContent])}, want ${JSON.stringify(wCut)}`);
check('X9 raw part in its own font', wCut.raw !== xc.fitLine('Reporting Server', 'hec53v037146.sin.hec.xsd-vlab.com', 6, 180,
    (t: string) => measureW(t, P14), (t: string) => measureW(t, P14)).raw, 'the 12 px raw part measured as 14 px gives the same cut');
check('X9 name only', same9(nameOnly, wName) && wName.raw === '' && wName.name.endsWith(E) && nameOnly.rawP.style.marginLeft === '0',
    `parts ${JSON.stringify([nameOnly.nameP.textContent, nameOnly.rawP.textContent])}, want ${JSON.stringify(wName)}`);
check('X9 band: the name fits but no raw character does, so the name ends in the ellipsis', same9(bandLine, wBand)
    && wBand.raw === '' && wBand.name.endsWith(E) && bandLine.rawP.style.marginLeft === '0',
    `parts ${JSON.stringify([bandLine.nameP.textContent, bandLine.rawP.textContent])}, want ${JSON.stringify(wBand)}`);
check('X9 white space collapsed', same9(spaced, wSpaced), `parts ${JSON.stringify([spaced.nameP.textContent, spaced.rawP.textContent])}, want ${JSON.stringify(wSpaced)}`);
check('X9 padding off the room', same9(padded, wPadded), `parts ${JSON.stringify([padded.nameP.textContent, padded.rawP.textContent])}, want ${JSON.stringify(wPadded)}`);
check('X9 untouched', [fitLineEl, onePx, noClip].every((l: any) => l.nameP.textContent === 'Payroll DB' && l.rawP.textContent === 'hec53v014023')
    && noParts.textContent === 'x - y' && hiddenLeaf.textContent === 'Reporting Server' && hiddenLeaf.style.whiteSpace === undefined
    && partsOf(lineEls).every((p: any) => p.style.whiteSpace === undefined && p.style.width === undefined),
    'a line that fits or overflows by one pixel, a line that does not clip, a line without parts, a hidden leaf or a part'
    + ' handled as a leaf was changed');

// X6
const AD = read(path.join(HOME, 'components/ActionsDropdown.tsx'));
const onclone = (/onclone:\s*\(clonedDoc: Document\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(AD) || [])[1] || '';
// Comments stripped, the body split into statements: exactly these, in this
// order, each a bare statement (not commented out, not under a condition of
// its own, not deferred; html2canvas waits only for onclone's return value).
const statements = onclone.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    .split(';').map((st: string) => st.replace(/\s+/g, ' ').trim()).filter((st: string) => st !== '');
const WANT_ONCLONE = [
    'freezeAnimationsInClone(clonedDoc)',
    'if (svgRasters) applySvgRastersToClone(clonedDoc, svgRasters)',
    'normalizeNumericGlyphsInClone(clonedDoc)',
    'replaceFormTextInClone(clonedDoc)',
    'ellipsizeCutTextInClone(clonedDoc)',
];
check('X6 onclone found', onclone.length > 0, 'no onclone: (clonedDoc: Document) => { ... } in ActionsDropdown.tsx');
check('X6 statements', JSON.stringify(statements) === JSON.stringify(WANT_ONCLONE),
    `onclone statements ${JSON.stringify(statements)}, want ${JSON.stringify(WANT_ONCLONE)}`);
check('X6 imports', /import \{[^}]*\bellipsizeCutTextInClone\b[^}]*\bnormalizeNumericGlyphsInClone\b[^}]*\breplaceFormTextInClone\b[^}]*\} from '\.\.\/utils\/exportCapture';/.test(AD),
    'ActionsDropdown does not import the three clone steps from utils/exportCapture');
check('X6 one capture', (AD.match(/html2canvas\(/g) || []).length === 1, 'ActionsDropdown calls html2canvas more than once');

// X7
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d: any) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(d.name) && !/consistency-test/.test(d.name) ? [p] : [];
});
const clamps: string[] = [];
walk(HOME).forEach((p: string) => {
    const re = /-webkit-line-clamp:\s*([^;]+);/g;
    const src = read(p);
    let m = re.exec(src);
    while (m) {
        clamps.push(`${path.relative(HOME, p)}: ${m[1].trim()}`);
        m = re.exec(src);
    }
});
check('X7 one-line clamps only', clamps.length > 0 && clamps.every((c: string) => /: 1$/.test(c)),
    `-webkit-line-clamp values in source: ${clamps.join(' ; ')}`);
check('X7 HostName clamp', clamps.some((c: string) => /HostName\.tsx: 1$/.test(c)), `clamps: ${clamps.join(' ; ')}`);

// X10 (build 406): form fields drawn as text.
const formKinds: Array<[string, string | null, string | null]> = [
    ['INPUT', null, 'line'], ['input', 'text', 'line'], ['input', 'SEARCH', 'line'], ['input', 'number', 'line'],
    ['input', 'email', 'line'], ['input', 'url', 'line'], ['input', 'tel', 'line'], ['TEXTAREA', null, 'area'],
    ['textarea', 'text', 'area'], ['input', 'password', null], ['input', 'checkbox', null], ['input', 'radio', null],
    ['input', 'hidden', null], ['input', 'file', null], ['input', 'range', null], ['select', null, null], ['div', 'text', null],
    ['', null, null],
];
const x10Bad = formKinds.filter(([tag, type, want]) => xc.formTextKind(tag, type) !== want)
    .map(([tag, type, want]) => `${tag}/${type}: ${xc.formTextKind(tag, type)}, want ${want}`).join(' ; ');
check('X10 formTextKind', x10Bad === '', x10Bad);
{
    const mkField = (tag: string, type: string | null, value: string, placeholder: string | null, cs: any, box: any): any => {
        const el: any = {
            tagName: tag, value, clientHeight: box.clientHeight, offsetWidth: box.offsetWidth, offsetHeight: box.offsetHeight,
            getAttribute: (n: string) => (n === 'type' ? type : n === 'placeholder' ? placeholder : null),
            cs,
        };
        return el;
    };
    const csOf = (o: any): any => ({ ...o, getPropertyValue: (p: string) => (o.props && o.props[p]) || '' });
    const replaced: any[] = [];
    const parent: any = { replaceChild: (box: any, old: any) => replaced.push([box, old]) };
    const baseCs = { display: 'inline-block', visibility: 'visible', color: 'rgb(1, 2, 3)', paddingTop: '6px', paddingBottom: '6px',
        fontSize: '14px', lineHeight: '20px', props: { 'font-size': '14px', 'padding-left': '10px' } };
    const line = mkField('INPUT', 'text', 'hec53v013858', 'Filter', csOf(baseCs), { clientHeight: 30, offsetWidth: 160, offsetHeight: 32 });
    const empty = mkField('INPUT', null, '', 'Filter by host', csOf(baseCs), { clientHeight: 30, offsetWidth: 160, offsetHeight: 32 });
    const area = mkField('TEXTAREA', null, 'host,alias\nhec53v013858,Reporting Server', null, csOf({ ...baseCs, display: 'block' }),
        { clientHeight: 68, offsetWidth: 260, offsetHeight: 70 });
    const pass = mkField('INPUT', 'password', 'secret', null, csOf(baseCs), { clientHeight: 30, offsetWidth: 160, offsetHeight: 32 });
    const hiddenF = mkField('INPUT', 'text', 'x', null, csOf({ ...baseCs, display: 'none' }), { clientHeight: 0, offsetWidth: 0, offsetHeight: 0 });
    const fields = [line, empty, area, pass, hiddenF];
    fields.forEach((f: any) => { f.parentNode = parent; });
    const mkBox = (): any => {
        const props: Record<string, string> = {};
        const attrs: Record<string, string> = {};
        return { style: { props, setProperty: (k: string, v: string) => { props[k] = v; } }, attrs,
            setAttribute: (k: string, v: string) => { attrs[k] = v; }, textContent: '' };
    };
    const doc: any = {
        defaultView: { getComputedStyle: (el: any, pseudo?: string) => (pseudo === '::placeholder' ? { color: 'rgb(9, 9, 9)' } : el.cs) },
        body: { querySelectorAll: () => fields },
        createElement: () => mkBox(),
    };
    const n10 = xc.replaceFormTextInClone(doc);
    const boxOf = (f: any): any => (replaced.find((r: any) => r[1] === f) || [null])[0];
    check('X10 count', n10 === 3 && replaced.length === 3, `replaced ${n10} / ${replaced.length}, want 3 (text box, empty text box, textarea)`);
    check('X10 password and hidden fields left', !boxOf(pass) && !boxOf(hiddenF), 'a password field or a hidden field was replaced');
    const lb = boxOf(line);
    check('X10 line', !!lb && lb.textContent === 'hec53v013858' && lb.attrs['data-logserv-export'] === 'form-line'
        && lb.style.props['white-space'] === 'pre' && lb.style.props['text-overflow'] === 'ellipsis' && lb.style.props.overflow === 'hidden'
        && lb.style.props.width === '160px' && lb.style.props.height === '32px' && lb.style.props['line-height'] === '18px'
        && lb.style.props.color === 'rgb(1, 2, 3)' && lb.style.props['box-sizing'] === 'border-box' && lb.style.props.display === 'inline-block'
        && lb.style.props['font-size'] === '14px' && lb.style.props['padding-left'] === '10px',
        `text box stand-in: ${JSON.stringify(lb && [lb.textContent, lb.attrs, lb.style.props])}`);
    const eb = boxOf(empty);
    check('X10 placeholder', !!eb && eb.textContent === 'Filter by host' && eb.style.props.color === 'rgb(9, 9, 9)',
        `empty text box stand-in: ${JSON.stringify(eb && [eb.textContent, eb.style.props.color])}`);
    const ab = boxOf(area);
    check('X10 area', !!ab && ab.textContent === 'host,alias\nhec53v013858,Reporting Server' && ab.attrs['data-logserv-export'] === 'form-area'
        && ab.style.props['white-space'] === 'pre-wrap' && ab.style.props['overflow-wrap'] === 'break-word' && ab.style.props.overflow === 'hidden'
        && ab.style.props['text-overflow'] === undefined && ab.style.props['line-height'] === '20px' && ab.style.props.display === 'block'
        && ab.style.props.width === '260px' && ab.style.props.height === '70px',
        `textarea stand-in: ${JSON.stringify(ab && [ab.textContent, ab.attrs, ab.style.props])}`);
    const origWarn10 = console.warn;
    let warned10 = 0;
    console.warn = () => { warned10 += 1; };
    let threw10 = '';
    let r10 = -1;
    try {
        r10 = xc.replaceFormTextInClone({ defaultView: { getComputedStyle: () => { throw new Error('boom'); } },
            body: { querySelectorAll: () => [line] }, createElement: () => mkBox() } as any);
    } catch (err) {
        threw10 = String(err);
    }
    console.warn = origWarn10;
    check('X10 never throws', threw10 === '' && r10 === 0 && warned10 === 1, `threw ${threw10}, returned ${r10}, ${warned10} warnings`);
    check('X10 no window', xc.replaceFormTextInClone({ defaultView: null, body: {} } as any) === 0, 'a clone without a window was changed');
}

if (xFailures > 0) {
    process.stderr.write(`exportCapture.consistency-test: ${xFailures} of ${xChecks} checks FAILED\n`);
    process.exit(1);
}
console.log(`exportCapture.consistency-test: ${xChecks} checks passed`);
