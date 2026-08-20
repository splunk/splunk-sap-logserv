/**
 * Build-time consistency test for `reactText.ts` (design §14.6, build 313).
 *
 * The extractor feeds the diagnosis drawer header and the panel report's scope
 * line ("Panel diagnosis — <title>"), so a wrong answer here labels a support
 * artifact. The cases pin: plain strings, numbers, nested arrays, element
 * shapes (`{props: {children}}`), element-only trees (→ undefined, NOT ''),
 * and the React-renders-nothing values (boolean/null/undefined).
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const proc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = require('./reactText') as any;
const textFromNode = mod.textFromNode as (n: unknown) => string | undefined;

let failures = 0;
let checks = 0;
const fail = (m: string): void => {
    failures += 1;
    proc.stderr.write(`FAIL: ${m}\n`);
};
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) fail(`${label}: ${detail}`);
};

const el = (children: unknown): unknown => ({ props: { children } });

const cases: Array<{ label: string; node: unknown; want: string | undefined }> = [
    { label: 'plain string', node: 'Volume by Type', want: 'Volume by Type' },
    { label: 'number', node: 42, want: '42' },
    { label: 'empty string', node: '', want: undefined },
    { label: 'whitespace-only', node: '   ', want: undefined },
    { label: 'null', node: null, want: undefined },
    { label: 'undefined', node: undefined, want: undefined },
    { label: 'boolean (renders nothing in React)', node: true, want: undefined },
    { label: 'array of strings', node: ['SAP ', 'Router'], want: 'SAP Router' },
    { label: 'mixed array', node: ['Events ', 42, null, ' total'], want: 'Events 42 total' },
    { label: 'element wrapping a string', node: el('Firewall Drops'), want: 'Firewall Drops' },
    {
        label: 'nested elements + arrays (the JSX-title shape)',
        node: el(['Top ', el('Hosts'), ' by Volume']),
        want: 'Top Hosts by Volume',
    },
    { label: 'element-only tree (icon, no text)', node: el(el(null)), want: undefined },
    { label: 'element with no props', node: {}, want: undefined },
    {
        label: 'fragment-like with number child',
        node: el([el(7), ' days']),
        want: '7 days',
    },
];

cases.forEach((c) => {
    const got = textFromNode(c.node);
    check(c.label, got === c.want, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`);
});

// Depth cap: a deeply nested chain must not throw and must degrade to
// undefined rather than a partial lie about the visible title.
{
    let deep: unknown = 'buried';
    for (let i = 0; i < 20; i += 1) deep = el(deep);
    let threw = false;
    let out: string | undefined;
    try {
        out = textFromNode(deep);
    } catch {
        threw = true;
    }
    check('depth cap does not throw', !threw, 'threw on a 20-deep chain');
    check('depth cap degrades to undefined', out === undefined, `got ${JSON.stringify(out)}`);
}

// A cyclic structure (impossible from real JSX, cheap to guard) must not hang.
{
    const a: { props: { children?: unknown } } = { props: {} };
    a.props.children = a;
    let threw = false;
    try {
        textFromNode(a);
    } catch {
        threw = true;
    }
    check('cyclic structure does not throw', !threw, 'threw on a cycle');
}

if (failures > 0) {
    proc.stderr.write(`reactText consistency test: ${failures} FAILURE(S) in ${checks} checks\n`);
    proc.exit(1);
}
console.log(`reactText consistency test: ${checks} checks OK`);
