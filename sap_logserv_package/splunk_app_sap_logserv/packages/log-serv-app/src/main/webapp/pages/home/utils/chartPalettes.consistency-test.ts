/**
 * Build-time consistency test for the chart colour maps (session 132).
 *
 * What it pins, and why each one is here rather than left to review:
 *
 *  - CASE VARIANTS AGREE, AND THE SEVERITY + RISK WORDS HAVE ALL THREE. A series
 *    name matches statusFieldColors only EXACTLY, so a word listed in lower and
 *    Title case but not UPPER silently falls through to Splunk's default palette.
 *    HANA Audit's Risk-Tiered Event Timeline emits HIGH / MEDIUM / LOW and drew
 *    HIGH in purple and MEDIUM in teal until session 132 - distinct colours with
 *    no meaning, which no screenshot review had flagged.
 *  - WORDS THAT APPEAR ON THE SAME CHART NEVER SHARE A COLOUR. Windows' severity
 *    vocabulary (critical / high / medium / informational) mixes the severity and
 *    the risk words; with critical on the same red as high, the two drew
 *    identically (measured on Severity Distribution Over Time, session 132).
 *  - THE COUNT-AWARE FALLBACK (build 352) returns the requested ramp whenever it
 *    can give every series its own colour, and the categorical palette only when
 *    it cannot - so it can never touch a chart whose colours already fit.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module - see session-085 sticky #4.
export {};

const cpProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const cp = require('../styles/chartPalettes') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const { statusFieldColors, paletteColors, paletteColorsFor } = cp;

let cpFailures = 0;
let cpChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    cpChecks += 1;
    if (!ok) {
        cpFailures += 1;
        cpProc.stderr.write(`FAIL: ${label}: ${detail}\n`);
    }
};

const MODES = ['dark', 'light'];
const title = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/* Words a series name really arrives in, in any of three cases. */
const FULL_CASE_WORDS = ['info', 'warning', 'error', 'fatal', 'critical', 'high', 'medium', 'low'];

/* Vocabularies that share ONE chart - every pair inside a group must differ. */
const CO_OCCURRING: Array<{ name: string; words: string[] }> = [
    { name: 'Windows severity', words: ['critical', 'high', 'medium'] },
    { name: 'log severity', words: ['info', 'warning', 'error', 'fatal'] },
    { name: 'risk tier', words: ['high', 'medium', 'low'] },
    { name: 'critical vs error', words: ['critical', 'error'] },
];

for (const mode of MODES) {
    const m = statusFieldColors(mode) as Record<string, string>;
    const keys = Object.keys(m);
    check(`A0 ${mode}: the map is populated (denominator)`, keys.length >= 30,
        `only ${keys.length} keys - did the import resolve?`);

    /* A1 - every word's PRESENT case variants map to one colour. */
    /* A plain object, not a Map: the project's tsc target does not allow
     * iterating a Map with for..of (TS2802). */
    const byWord: Record<string, string[]> = {};
    for (const k of keys) {
        const w = k.toLowerCase();
        if (!byWord[w]) byWord[w] = [];
        byWord[w].push(k);
    }
    for (const w of Object.keys(byWord)) {
        const variants: string[] = byWord[w];
        const colours: Record<string, true> = {};
        variants.forEach((k: string) => { colours[m[k]] = true; });
        check(`A1 ${mode}: "${w}" case variants agree`, Object.keys(colours).length === 1,
            variants.map((k: string) => `${k}=${m[k]}`).join(', '));
    }

    /* A2 - the severity and risk words exist in all three cases. */
    for (const w of FULL_CASE_WORDS) {
        const missing = [w, title(w), w.toUpperCase()].filter((k) => !(k in m));
        check(`A2 ${mode}: "${w}" has lower, Title and UPPER forms`, missing.length === 0,
            `missing ${missing.join(', ')} - a series named that way gets Splunk's default colour`);
    }

    /* B1 - words that share a chart never share a colour. */
    for (const g of CO_OCCURRING) {
        for (let i = 0; i < g.words.length; i += 1) {
            for (let j = i + 1; j < g.words.length; j += 1) {
                const a = g.words[i];
                const b = g.words[j];
                check(`B1 ${mode}: ${g.name} - ${a} and ${b} differ`, m[a] !== m[b],
                    `both ${m[a]}`);
            }
        }
    }
    /* B2 - pins the session-132 decision itself, so a later edit that moves
     * critical off deep red has to change this line and say why. */
    check(`B2 ${mode}: critical takes fatal's deep red`, m.critical === m.fatal,
        `critical=${m.critical} fatal=${m.fatal}`);

    /* C - the count-aware fallback. */
    const cat = paletteColors('categorical', mode) as string[];
    check(`C0 ${mode}: categorical palette has 11 colours (denominator)`, cat.length === 11,
        `got ${cat.length}`);
    for (const [pal, len] of [['errors', 2], ['errors-2', 2], ['errors-3', 2], ['auth', 5], ['volume', 5]] as Array<[string, number]>) {
        const ramp = paletteColors(pal, mode) as string[];
        check(`C1 ${mode}: ${pal} is a ${len}-colour ramp`, ramp.length === len, `got ${ramp.length}`);
        check(`C2 ${mode}: ${pal} with ${len} series keeps its own ramp`,
            JSON.stringify(paletteColorsFor(len, pal, mode)) === JSON.stringify(ramp),
            'the fallback must not touch a chart whose colours fit');
        check(`C3 ${mode}: ${pal} with ${len + 1} series falls back to categorical`,
            JSON.stringify(paletteColorsFor(len + 1, pal, mode)) === JSON.stringify(cat),
            'one series past the ramp repeats a colour');
    }
    check(`C4 ${mode}: status and unset palettes stay unset (fields map by name)`,
        paletteColorsFor(9, 'status', mode) === undefined && paletteColorsFor(9, undefined, mode) === undefined,
        'status colours come from seriesColorsByField, not a list');
}

if (cpFailures > 0) {
    cpProc.stderr.write(`\nchartPalettes.consistency-test: ${cpFailures} failure(s) of ${cpChecks}\n`);
    cpProc.exit(1);
}
console.log(`chartPalettes.consistency-test: OK (${cpChecks} checks)`);
