/**
 * Build-time consistency test for utils/vendorCost.ts (App build 377, AI-b).
 *
 * What it pins:
 *  - A. Every model id the providers list statically (Anthropic, Bedrock,
 *    OpenAI, and the hook's fallback id) has a price, so a turn on a listed
 *    model never reads $0 and always counts toward daily_spend_cap_usd.
 *  - B. The Claude 5.x ids carry the published first-party prices (input,
 *    output, cache read - each model's own rate) and a cache write of 1.25x
 *    input; claude-sonnet-5 is no longer the stale $3 / $15.
 *  - C. Every entry is finite and non-negative; the lookup is exact - no
 *    prefix match, no date-suffix match; an unknown id costs 0.
 *  - D. The arithmetic: base input, output, cache reads and writes (each at
 *    its own rate, the base input rate when an entry has none) and the
 *    6-decimal rounding.
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

// Standalone script, not a module.
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');
const vcost = require('./vendorCost');

const HOME = path.resolve(__dirname, '..');

let costFailures = 0;
let costChecks = 0;
const check = (name: string, cond: boolean, detail: string): void => {
    costChecks += 1;
    if (!cond) {
        costFailures += 1;
        process.stderr.write(`FAIL ${name}: ${detail}\n`);
    }
};
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const P = vcost.MODEL_PRICING;

/* ============================ A. every listed model is priced ============================ */

const listed = (file: string): string[] => {
    const src: string = fs.readFileSync(path.join(HOME, 'components/ai/providers', file), 'utf8').replace(/\r\n/g, '\n');
    return (src.match(/^\s+id: '([^']+)',$/gm) || []).map((l) => (/'([^']+)'/.exec(l) as RegExpExecArray)[1]);
};
const anthropic = listed('AnthropicProvider.ts');
const bedrock = listed('BedrockProvider.ts');
const openai = listed('OpenAIProvider.ts');
check('A1 the provider model lists were read', anthropic.length >= 3 && bedrock.length >= 3 && openai.length >= 4,
    `${anthropic.length} / ${bedrock.length} / ${openai.length}`);
const unpriced = anthropic.concat(bedrock, openai).filter((id) => !Object.prototype.hasOwnProperty.call(P, id));
check('A2 every statically listed model id has a price', unpriced.length === 0, unpriced.join(', '));
const hook: string = fs.readFileSync(path.join(HOME, 'hooks/useAIAssistant.ts'), 'utf8');
const fb = /model: ctx\.selectedModel \|\| provider\.models\[0\]\?\.id \|\| '([^']+)'/.exec(hook);
check('A3 the hook\'s fallback model id is priced', !!fb && Object.prototype.hasOwnProperty.call(P, fb[1]) && P[fb[1]].input > 0,
    fb ? fb[1] : 'not found');

/* ============================ B. the Claude 5.x prices ============================ */

// USD per million tokens: input, output, cache read (Anthropic API reference, 2026-10-06, first-party rates).
const REQUIRED_377: Array<[string, number, number, number]> = [
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1.0],
    ['claude-opus-5-5', 4, 20, 0.2],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-sonnet-5-5', 2, 10, 0.2],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
];
for (const [id, i, o, c] of REQUIRED_377) {
    const p = P[id];
    check(`B1 ${id}: $${i} / $${o}, cache read $${c}, cache write 1.25x input`, !!p && near(p.input, i) && near(p.output, o)
        && near(p.cachedInput, c) && near(p.cacheCreation, i * 1.25), JSON.stringify(p));
}
check('B2 the 4.x Anthropic prices are unchanged', near(P['claude-opus-4-8'].input, 5) && near(P['claude-sonnet-4-6'].input, 3)
    && near(P['claude-haiku-4-5'].output, 5) && near(P['claude-haiku-4-5-20251001'].output, 5), '');
check('B3 the Bedrock entries are not derived from the first-party table (unchanged)', near(P['anthropic.claude-sonnet-5-v1:0'].input, 3)
    && near(P['anthropic.claude-opus-4-8-v1:0'].input, 5) && P['anthropic.claude-sonnet-5-v1:0'].cachedInput === undefined, '');

/* ============================ C. shape and exact lookup ============================ */

const notFinite = Object.keys(P).filter((id) => ['input', 'output', 'cachedInput', 'cacheCreation']
    .some((k) => P[id][k] !== undefined && !(typeof P[id][k] === 'number' && Number.isFinite(P[id][k]) && P[id][k] >= 0)));
check('C1 every price is a finite, non-negative number', notFinite.length === 0, notFinite.join(', '));
check('C2 the table is frozen', Object.isFrozen(P), '');
const noMatch = ['claude-opus-5-5-x', 'claude-opus', 'claude-opus-5-5-20260401', 'Claude-Opus-5-5', ' claude-opus-5-5', 'claude-fable',
    'anthropic.claude-opus-5-5', 'claude-mythos-5-1', ''];
const priced = noMatch.filter((id) => vcost.estimateTurnCostUsd(id, 1_000_000, 1_000_000, 1_000_000, 1_000_000) !== 0);
check('C3 no prefix, suffix or case match: an unlisted id costs 0', priced.length === 0, priced.join(', '));
check('C4 the mock models cost nothing', ['mock-fast', 'mock-deep'].every((id) => vcost.estimateTurnCostUsd(id, 1e6, 1e6, 1e6, 1e6) === 0
    && Object.prototype.hasOwnProperty.call(P, id)), '');

/* ============================ D. the arithmetic ============================ */

check('D1 one million input and output tokens on claude-opus-5-5 cost $24', vcost.estimateTurnCostUsd('claude-opus-5-5', 1e6, 1e6) === 24, '');
check('D2 cache reads and writes at their own rates', vcost.estimateTurnCostUsd('claude-opus-5-5', 0, 0, 1e6, 0) === 0.2
    && vcost.estimateTurnCostUsd('claude-opus-5-5', 0, 0, 0, 1e6) === 5 && vcost.estimateTurnCostUsd('claude-fable-5', 0, 0, 1e6, 0) === 1
    && vcost.estimateTurnCostUsd('claude-fable-5-1', 0, 0, 1e6, 0) === 0.25, '');
check('D3 an entry without cache rates prices cache tokens at the base input rate', vcost.estimateTurnCostUsd('gpt-5', 0, 0, 1e6, 1e6) === 2.5, '');
check('D4 a realistic turn: 12,345 in, 678 out, 40,000 cache reads on claude-sonnet-5-5',
    vcost.estimateTurnCostUsd('claude-sonnet-5-5', 12345, 678, 40000) === 0.03947, String(vcost.estimateTurnCostUsd('claude-sonnet-5-5', 12345, 678, 40000)));
check('D5 rounded to 6 decimals', vcost.estimateTurnCostUsd('claude-haiku-5-5', 1, 1) === 0.000001
    && vcost.estimateTurnCostUsd('claude-haiku-5-5', 3, 0) === 0, String(vcost.estimateTurnCostUsd('claude-haiku-5-5', 1, 1)));
check('D6 an unknown model and zero tokens give a finite 0', vcost.estimateTurnCostUsd('nope', 5, 5) === 0
    && vcost.estimateTurnCostUsd('claude-opus-5-5', 0, 0) === 0, '');

/* ===================================================================== */

if (costFailures > 0) {
    process.stderr.write(`\nvendorCost.consistency-test: ${costFailures} failure(s) of ${costChecks}\n`);
    process.exit(1);
}
console.log(`vendorCost.consistency-test: OK (${costChecks} checks; ${Object.keys(P).length} priced ids, every statically listed`
    + ` model among them; the Claude 5.x ids at the published first-party rates)`);
