/**
 * Runtime tests for the MCP Server version gate.
 *
 * Run with: `npx ts-node --transpile-only versionGate.runtime-test.ts`
 *
 * The gate's job is to:
 *   1. Refuse versions < MIN_MCP_SERVER_VERSION (CVE-2026-20205).
 *   2. Accept versions >= MIN_MCP_SERVER_VERSION.
 *   3. Treat malformed/missing versions as "fail closed" → refuse.
 *   4. Strip pre-release suffixes for the comparison so 1.0.3-rc1 still
 *      meets the bar of 1.0.3.
 */

/* eslint-disable no-console */

import { compareVersions, meetsMinVersion, MIN_MCP_SERVER_VERSION } from '../mcp/versionGate';

interface CompareCase {
    a: string;
    b: string;
    expectSign: -1 | 0 | 1;
}

interface MeetsCase {
    installed: string;
    required?: string;
    expect: boolean;
}

const sgn = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

const compareCases: CompareCase[] = [
    { a: '1.0.0', b: '1.0.0', expectSign: 0 },
    { a: '1.0.3', b: '1.0.3', expectSign: 0 },
    { a: '1.0.2', b: '1.0.3', expectSign: -1 },
    { a: '1.0.4', b: '1.0.3', expectSign: 1 },
    { a: '1.1.0', b: '1.0.3', expectSign: 1 },
    { a: '0.9.99', b: '1.0.3', expectSign: -1 },
    { a: '2.0.0', b: '1.99.99', expectSign: 1 },
    { a: '1.0.3-rc1', b: '1.0.3', expectSign: 0 },
    { a: '1.0.3-beta', b: '1.0.3-rc1', expectSign: 0 },
    { a: '1.0.3', b: '1.0.4-pre', expectSign: -1 },
];

const meetsCases: MeetsCase[] = [
    { installed: '1.0.3', expect: true },
    { installed: '1.0.4', expect: true },
    { installed: '1.1.0', expect: true },
    { installed: '2.0.0', expect: true },
    { installed: '1.0.2', expect: false },
    { installed: '1.0.0', expect: false },
    { installed: '0.9.99', expect: false },
    { installed: '1.0.3-rc1', expect: true },
    // Fail-closed cases:
    { installed: '', expect: false },
    { installed: 'not-a-version', expect: false },
    { installed: '1', expect: false },
    { installed: '1.0', expect: false },
    { installed: 'v1.0.3', expect: false }, // we don't strip leading 'v'
    // Custom required:
    { installed: '1.5.0', required: '2.0.0', expect: false },
    { installed: '2.0.0', required: '2.0.0', expect: true },
];

let failed = 0;

console.log(`MIN_MCP_SERVER_VERSION = ${MIN_MCP_SERVER_VERSION}`);
console.log(`Running ${compareCases.length} compareVersions cases...`);

for (const tc of compareCases) {
    const got = sgn(compareVersions(tc.a, tc.b));
    if (got !== tc.expectSign) {
        failed++;
        console.error(`FAIL compareVersions("${tc.a}", "${tc.b}"): expected ${tc.expectSign}, got ${got}`);
    }
}

console.log(`Running ${meetsCases.length} meetsMinVersion cases...`);

for (const tc of meetsCases) {
    const got = meetsMinVersion(tc.installed, tc.required);
    if (got !== tc.expect) {
        failed++;
        console.error(
            `FAIL meetsMinVersion("${tc.installed}", "${tc.required ?? MIN_MCP_SERVER_VERSION}"): expected ${tc.expect}, got ${got}`,
        );
    }
}

if (failed > 0) {
    console.error(`\n${failed} cases failed.`);
    throw new Error(`versionGate: ${failed} cases failed`);
} else {
    console.log(`\nAll ${compareCases.length + meetsCases.length} cases passed.`);
}

export {};
