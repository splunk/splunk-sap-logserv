#!/usr/bin/env node
/**
 * check-intent-map.js — run the intent-map ↔ savedsearches.conf consistency
 * test as part of `yarn build`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `intentMap.consistency-test.ts` is the build-time guard against the
 * threat-model issue in §9.1 of the AI Assistant design doc: a canned prompt's
 * pre-baked SPL drifting from the saved-search it dispatches by name. Its own
 * header says "CI fails on drift" — but it was never actually wired into any
 * script, so nothing ran it. By session 091 it had been failing for ~40 builds
 * with 75 stale errors that nobody saw (the reverse pass had not been widened
 * when the KV-Store rollup pipeline grew from one collection to ~25). This
 * runner closes that gap: the test now runs on every build, first, so a
 * consistency failure costs three seconds instead of a full webpack pass.
 *
 * WHY IT COMPILES INTO THE SOURCE TREE
 * ------------------------------------
 * The test resolves `savedsearches.conf` / `logserv_intent_map.json` by
 * walking up from `__dirname`, so the emitted .js must sit next to its .ts.
 * We compile to a temp dir, copy the one file in, run it, and always remove it
 * again (finally). This keeps the documented manual invocation working
 * unchanged and needs no edit to the test itself.
 *
 * `typescript` is resolved by EXPLICIT relative path rather than
 * `require.resolve('typescript/bin/tsc')`: this repo lives beside sibling
 * version snapshots, and Node's upward node_modules walk has been observed
 * resolving into a *different* snapshot's tree (the same quirk that mislabels
 * elkjs in webpack output). An explicit path keeps the toolchain pinned to
 * this snapshot.
 *
 * Exit code is the test's own: 0 = consistent, non-zero = drift.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.resolve(
    __dirname, '..', 'src', 'main', 'webapp', 'pages', 'home', 'components', 'ai', '__tests__',
);
const TEST_NAME = 'intentMap.consistency-test';
const TEST_TS = path.join(TEST_DIR, `${TEST_NAME}.ts`);
const TEST_JS = path.join(TEST_DIR, `${TEST_NAME}.js`);

function fail(msg) {
    console.error(`check-intent-map: ${msg}`);
    process.exit(1);
}

if (!fs.existsSync(TEST_TS)) fail(`test not found at ${TEST_TS}`);

// Never clobber a pre-existing .js — that would mean either a stale artifact
// from a crashed run or a real source file we must not delete.
if (fs.existsSync(TEST_JS)) {
    fail(`${TEST_JS} already exists (stale artifact from an interrupted run?). `
        + 'Remove it and re-run.');
}

// packages/log-serv-app/bin -> packages/log-serv-app -> packages -> splunk_app_sap_logserv
const TSC = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(TSC)) fail(`typescript not found at ${TSC}`);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logserv-intentmap-'));

let code = 1;
try {
    const tsc = spawnSync(
        process.execPath,
        [TSC, TEST_TS, '--outDir', outDir, '--module', 'commonjs',
            '--target', 'ES2017', '--skipLibCheck'],
        { stdio: 'inherit' },
    );
    if (tsc.status !== 0) fail('the consistency test failed to compile');

    const emitted = path.join(outDir, `${TEST_NAME}.js`);
    if (!fs.existsSync(emitted)) fail(`tsc produced no output at ${emitted}`);

    fs.copyFileSync(emitted, TEST_JS);
    const run = spawnSync(process.execPath, [TEST_JS], { stdio: 'inherit' });
    code = run.status === null ? 1 : run.status;
} finally {
    try { fs.unlinkSync(TEST_JS); } catch (e) { /* never created */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

if (code !== 0) {
    console.error('\ncheck-intent-map: intent map and savedsearches.conf are INCONSISTENT.');
    console.error('Each prompt\'s `spl` must byte-match the `search =` line of the '
        + 'savedsearches.conf stanza named by its `savedSearch`.');
    console.error('Edit BOTH files together — see the sticky notes in CLAUDE.md.');
}
process.exit(code);
