/**
 * Runtime corpus test for `outboundGuard.scanForForbiddenKeys`.
 *
 * Constructs 200+ payload shapes — both clean and dirty — and verifies
 * the scanner rejects every dirty one and accepts every clean one.
 *
 * Run with: `node --enable-source-maps __tests__/outboundGuard.runtime-test.js`
 * after `tsc --outDir tmp` (or wire up jest in a future phase).
 *
 * For now it's a self-contained module with assertions. Failure throws
 * AssertionError on the first miss so CI can catch it via exit code.
 */

/* eslint-disable no-console */

import { scanForForbiddenKeys, FORBIDDEN_FIELD_NAMES } from '../providers';

interface TestCase {
    label: string;
    input: unknown;
    expectViolations: ReadonlyArray<string>;
}

const cases: TestCase[] = [];

// ----- Clean payloads (zero violations expected) -----

cases.push({
    label: 'empty object',
    input: {},
    expectViolations: [],
});

cases.push({
    label: 'simple message array',
    input: [{ role: 'user', content: 'show me errors in the last hour' }],
    expectViolations: [],
});

cases.push({
    label: 'tool def with description',
    input: {
        tools: [
            { name: 'search_splunk', description: 'Run an SPL query', inputSchema: {} },
        ],
    },
    expectViolations: [],
});

cases.push({
    label: 'nested but clean',
    input: {
        messages: [
            { role: 'system', content: 'You are a Splunk assistant.' },
            { role: 'user', content: 'find my data' },
            {
                role: 'assistant',
                content: 'Looking now...',
                toolCalls: [{ id: 'a', name: 'search_splunk', args: '{"q":"foo"}' }],
            },
        ],
    },
    expectViolations: [],
});

cases.push({
    label: 'arbitrarily deeply nested',
    input: { a: { b: { c: { d: { e: { f: 'still clean' } } } } } },
    expectViolations: [],
});

cases.push({
    label: 'array of arrays',
    input: [[[[{ deep: 'clean' }]]]],
    expectViolations: [],
});

// Pad with 100 clean variations
for (let i = 0; i < 100; i++) {
    cases.push({
        label: `clean variation ${i}`,
        input: { messages: [{ role: 'user', content: `prompt #${i}` }] },
        expectViolations: [],
    });
}

// ----- Dirty payloads (at least one violation expected) -----

cases.push({
    label: 'top-level _raw key',
    input: { _raw: 'Apr 27 12:00:00 hostname sshd: failed login' },
    expectViolations: ['_raw'],
});

cases.push({
    label: 'top-level _time key',
    input: { _time: '2026-04-27T12:00:00Z' },
    expectViolations: ['_time'],
});

cases.push({
    label: 'host inside an array element',
    input: { rows: [{ host: 'hec53v013858', count: 14 }] },
    expectViolations: ['host'],
});

cases.push({
    label: 'sourcetype deep inside payload',
    input: {
        messages: [
            {
                role: 'assistant',
                content: 'fine text',
                attachments: [{ sourcetype: 'sap:hana:audit' }],
            },
        ],
    },
    expectViolations: ['sourcetype'],
});

cases.push({
    label: 'multiple distinct violations',
    input: {
        rows: [
            { _raw: 'log1', _time: 't1', host: 'h1', sourcetype: 'st1' },
            { source: '/var/log/messages', index: 'main' },
        ],
    },
    expectViolations: ['_raw', '_time', 'host', 'index', 'source', 'sourcetype'],
});

cases.push({
    label: 'forbidden key with primitive value still flags',
    input: { _indextime: 1745700000 },
    expectViolations: ['_indextime'],
});

cases.push({
    label: 'forbidden key with null value still flags',
    input: { host: null },
    expectViolations: ['host'],
});

cases.push({
    label: 'forbidden key as object key in array',
    input: [{ punct: '..,..,..' }, { eventtype: 'sshd' }],
    expectViolations: ['eventtype', 'punct'],
});

cases.push({
    label: 'LogServ-specific identifier sap_sid',
    input: { metadata: { sap_sid: 'XCP', sap_inst: '00' } },
    expectViolations: ['sap_inst', 'sap_sid'],
});

cases.push({
    label: 'clz_dir / clz_subdir in nested structure',
    input: { props: [{ clz_dir: 'linux', clz_subdir: 'messages' }] },
    expectViolations: ['clz_dir', 'clz_subdir'],
});

cases.push({
    label: 'splunk_server in deep payload',
    input: { layer: { layer: { layer: { splunk_server: 'idx-01' } } } },
    expectViolations: ['splunk_server'],
});

// Pad with 100 dirty variations: each has _raw at random nesting
for (let i = 0; i < 100; i++) {
    const wrapper: Record<string, unknown> = {};
    let cur: Record<string, unknown> = wrapper;
    const depth = (i % 8) + 1;
    for (let d = 0; d < depth; d++) {
        const next: Record<string, unknown> = {};
        cur[`level${d}`] = next;
        cur = next;
    }
    cur._raw = `event #${i}`;
    cases.push({
        label: `dirty variation ${i} (depth ${depth})`,
        input: wrapper,
        expectViolations: ['_raw'],
    });
}

// ----- Sanity checks on the FORBIDDEN_FIELD_NAMES set itself -----

const corpusViolationCount = cases.filter((c) => c.expectViolations.length > 0).length;
const corpusCleanCount = cases.filter((c) => c.expectViolations.length === 0).length;

console.log(`Running ${cases.length} cases (${corpusCleanCount} clean, ${corpusViolationCount} dirty)`);
console.log(`FORBIDDEN_FIELD_NAMES has ${FORBIDDEN_FIELD_NAMES.size} entries`);

// ----- Run the corpus -----

let failed = 0;
for (const tc of cases) {
    const got = scanForForbiddenKeys(tc.input);
    const want = [...tc.expectViolations].sort();
    const gotSorted = [...got].sort();
    const ok = JSON.stringify(gotSorted) === JSON.stringify(want);
    if (!ok) {
        failed++;
        console.error(`FAIL [${tc.label}]`);
        console.error(`  expected: ${JSON.stringify(want)}`);
        console.error(`  got:      ${JSON.stringify(gotSorted)}`);
    }
}

if (failed > 0) {
    console.error(`\n${failed}/${cases.length} cases failed.`);
    // Use a thrown error so the test runner exits non-zero without
    // requiring @types/node (which the project's tsconfig doesn't include).
    throw new Error(`outboundGuard corpus: ${failed}/${cases.length} cases failed`);
} else {
    console.log(`\nAll ${cases.length} cases passed.`);
}

export {};
