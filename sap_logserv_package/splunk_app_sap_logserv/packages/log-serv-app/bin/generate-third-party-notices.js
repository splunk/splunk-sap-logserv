#!/usr/bin/env node
/**
 * generate-third-party-notices.js — emit THIRD-PARTY-NOTICES.md
 * from the workspace's resolved node_modules tree.
 *
 * Wired into `yarn build` so every release ships a notices file
 * that matches the bundled JS bytes — the App version + the
 * package versions in node_modules at build time end up agreeing.
 *
 * Why a custom script and not `license-checker` / `license-report`:
 *   - Zero external dependencies — works in any clean checkout
 *   - Walks node_modules directly (top-level only, dedup'd) so
 *     the count matches what shipped, not what's resolvable
 *   - Bundles full LICENSE/NOTICE/COPYING text (not just metadata)
 *     for legal-attestation completeness
 *   - Deterministic output (sorted by name) so diffing two release
 *     versions of the file shows package additions/removals/upgrades
 *
 * Output: Markdown file with header summary + per-package sections.
 *   Each section: name@version, license, repository, homepage,
 *   author, then a `<details>` block with each LICENSE/NOTICE file's
 *   contents in a fenced code block.
 *
 * Usage:
 *   yarn third-party-notices
 *   node bin/generate-third-party-notices.js [out-path] [--node-modules <path>] [--app-version <v>]
 *
 * Default output path: <PACKAGE_DIR>/stage/THIRD-PARTY-NOTICES.md
 *   (matches the SBOM placement so the tarball pipeline ships it
 *    at the root of the installed app dir alongside SBOM.json).
 *
 * Session 032 / Task B — Option 2 generator wired into `yarn build`.
 * Ported into v0.0.6.0 (session 059) to replace the older one-off
 * tools/scripts/generate_third_party_notices.js — same logic plus
 * the Absorbed Splunk add-ons section and app.conf version reading.
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const PACKAGE_DIR = path.join(SCRIPT_DIR, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

const args = parseArgs(process.argv.slice(2));
const NODE_MODULES = args['node-modules']
    ? path.resolve(args['node-modules'])
    : path.join(WORKSPACE_ROOT, 'node_modules');
const OUT = args._positional
    ? path.resolve(args._positional)
    : path.join(PACKAGE_DIR, 'stage', 'THIRD-PARTY-NOTICES.md');
const APP_NAME = args['app-name'] || 'Splunk for SAP LogServ';
const APP_VERSION = args['app-version'] || readAppConfVersion() || readPackageJsonVersion() || 'unknown';

if (!fs.existsSync(NODE_MODULES)) {
    console.error(`generate-third-party-notices: node_modules dir not found: ${NODE_MODULES}`);
    process.exit(1);
}

const LICENSE_FILE_NAMES = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENSE-MIT',
    'LICENSE-MIT.txt',
    'LICENSE-APACHE',
    'LICENSE-APACHE-2.0',
    'License',
    'License.md',
    'License.txt',
    'license',
    'license.md',
    'license.txt',
    'NOTICE',
    'NOTICE.md',
    'NOTICE.txt',
    'COPYING',
    'COPYING.md',
    'COPYING.txt',
    'UNLICENSE',
    'UNLICENSE.md',
    'UNLICENSE.txt',
];

/**
 * Walk node_modules to enumerate package directories. Handles:
 *   <node_modules>/<pkg>/                  (unscoped)
 *   <node_modules>/@<scope>/<pkg>/         (scoped)
 *
 * Skips:
 *   .bin, .cache, .yarn-state, anything starting with '.'
 *   nested node_modules (we walk the top-level resolved tree only;
 *     yarn flattens dependencies, so a nested node_modules
 *     indicates a peer-dep version conflict — those nested packages
 *     are typically already represented at the top level, and
 *     including them double-counts)
 */
function listPackageDirs(root) {
    const dirs = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const top = path.join(root, entry.name);
        if (entry.name.startsWith('@')) {
            for (const sub of fs.readdirSync(top, { withFileTypes: true })) {
                if (sub.isDirectory() && !sub.name.startsWith('.')) {
                    dirs.push(path.join(top, sub.name));
                }
            }
        } else {
            dirs.push(top);
        }
    }
    return dirs.sort();
}

function safeReadJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
        return null;
    }
}

function findLicenseFiles(dir) {
    const found = [];
    for (const name of LICENSE_FILE_NAMES) {
        const p = path.join(dir, name);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            found.push({ name, path: p });
        }
    }
    return found;
}

function readLicenseText(p) {
    try {
        const buf = fs.readFileSync(p);
        let text = buf.toString('utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        return text;
    } catch (err) {
        return `(failed to read license file: ${err.message})`;
    }
}

function normalizeLicense(licenseField) {
    if (!licenseField) return null;
    if (typeof licenseField === 'string') return licenseField;
    if (typeof licenseField === 'object' && licenseField.type) return licenseField.type;
    if (Array.isArray(licenseField)) {
        return licenseField
            .map((l) => (typeof l === 'string' ? l : l.type))
            .filter(Boolean)
            .join(' / ');
    }
    return JSON.stringify(licenseField);
}

function normalizeRepository(repoField) {
    if (!repoField) return null;
    if (typeof repoField === 'string') return repoField;
    if (typeof repoField === 'object' && repoField.url) return repoField.url;
    return null;
}

function normalizeAuthor(authorField) {
    if (!authorField) return null;
    if (typeof authorField === 'string') return authorField;
    if (typeof authorField === 'object') {
        const parts = [];
        if (authorField.name) parts.push(authorField.name);
        if (authorField.email) parts.push(`<${authorField.email}>`);
        if (authorField.url) parts.push(`(${authorField.url})`);
        return parts.join(' ');
    }
    return null;
}

/**
 * Read [id] version from <PACKAGE_DIR>/src/main/resources/splunk/default/app.conf.
 * This is the authoritative App version — beats the workspace package.json
 * which still reads "0.0.1" because it's an internal yarn-workspace marker.
 */
function readAppConfVersion() {
    const p = path.join(PACKAGE_DIR, 'src', 'main', 'resources', 'splunk', 'default', 'app.conf');
    if (!fs.existsSync(p)) return null;
    try {
        const text = fs.readFileSync(p, 'utf8');
        // Look for [id] section then version = X
        const m = text.match(/\[id\][^[]*?\nversion\s*=\s*([^\s\n]+)/);
        return m ? m[1] : null;
    } catch (err) {
        return null;
    }
}

function readPackageJsonVersion() {
    const p = path.join(PACKAGE_DIR, 'package.json');
    const pkg = safeReadJson(p);
    return pkg && pkg.version ? pkg.version : null;
}

const dirs = listPackageDirs(NODE_MODULES);
const records = [];
const counts = {
    walked: 0,
    withLicense: 0,
    withLicenseText: 0,
    noLicense: 0,
    parseError: 0,
};
const licenseTallies = new Map();

for (const dir of dirs) {
    counts.walked += 1;
    const pkgPath = path.join(dir, 'package.json');
    const pkg = safeReadJson(pkgPath);
    if (!pkg) {
        counts.parseError += 1;
        continue;
    }
    const name = pkg.name || path.relative(NODE_MODULES, dir).replace(/\\/g, '/');
    const version = pkg.version || '0.0.0';
    const license = normalizeLicense(pkg.license || pkg.licenses);
    const repository = normalizeRepository(pkg.repository);
    const homepage = pkg.homepage || null;
    const author = normalizeAuthor(pkg.author);
    const licenseFiles = findLicenseFiles(dir);

    if (license) counts.withLicense += 1;
    else counts.noLicense += 1;
    if (licenseFiles.length > 0) counts.withLicenseText += 1;

    const tallyKey = license || '(no license field)';
    licenseTallies.set(tallyKey, (licenseTallies.get(tallyKey) || 0) + 1);

    records.push({
        name,
        version,
        license,
        repository,
        homepage,
        author,
        licenseFiles,
    });
}

records.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    if (a.version < b.version) return -1;
    if (a.version > b.version) return 1;
    return 0;
});

const lines = [];
lines.push(`# Third-Party Software Notices and Information`);
lines.push('');
lines.push(`This document lists open-source software components included in **${APP_NAME}** version **${APP_VERSION}**.`);
lines.push('');
lines.push(`Each entry below was derived from the package's \`package.json\` and any LICENSE / NOTICE / COPYING files bundled in the package's installed directory under \`node_modules/\`.`);
lines.push('');
lines.push(`Per the licenses below, attribution is preserved. No source modifications have been made to any third-party component bundled with this app.`);
lines.push('');
lines.push(`This file is regenerated automatically as part of \`yarn build\`, so the listed package versions match the JavaScript bytes that ship with this release.`);
lines.push('');
lines.push(`---`);
lines.push('');
lines.push(`## Summary`);
lines.push('');
lines.push(`- **Total third-party packages:** ${records.length}`);
lines.push(`- **Packages with declared license field:** ${counts.withLicense}`);
lines.push(`- **Packages with bundled LICENSE/NOTICE/COPYING file:** ${counts.withLicenseText}`);
lines.push(`- **Packages without declared license field:** ${counts.noLicense}`);
if (counts.parseError > 0) {
    lines.push(`- **Packages with unparseable package.json (skipped):** ${counts.parseError}`);
}
lines.push('');
lines.push(`### License distribution`);
lines.push('');
lines.push(`| License (SPDX or text as declared) | Count |`);
lines.push(`|---|---:|`);
const sortedTallies = Array.from(licenseTallies.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
for (const [key, count] of sortedTallies) {
    lines.push(`| ${escapePipe(key)} | ${count} |`);
}
lines.push('');
lines.push(`---`);
lines.push('');

// Absorbed Splunk add-ons section (back-ported from v0.0.5.0 build 184,
// session 040). Absorbs parsing from two archived Splunkbase add-ons so
// customers no longer need them as standalone installs. Kept here in the
// generator so every `yarn build` regenerates the section in lockstep with
// the rest of the NOTICES content.
lines.push(`## Absorbed Splunk add-ons`);
lines.push('');
lines.push(`The Splunk App for SAP LogServ absorbed parsing artifacts (props.conf / transforms.conf / eventtypes.conf / tags.conf / lookup CSVs) from two **archived** Splunkbase add-ons published by Splunk Inc. The original add-ons have been archived by Splunk and are no longer actively maintained. The absorption was performed with organizational approval to retire the standalone-TA install dependency for customers of this app. Originally landed in v0.0.5.0 build 184 (session 040, 2026-05-12); carried forward into v0.1.x in session 041.`);
lines.push('');
lines.push(`### Splunk Add-on for ISC BIND v2.0.0`);
lines.push('');
lines.push(`- **Origin:** <https://splunkbase.splunk.com/app/4878> (archived)`);
lines.push(`- **License:** \`LicenseRef-Splunk-1-2020\` (full text in [\`LICENSES/LicenseRef-Splunk-1-2020.txt\`](LICENSES/LicenseRef-Splunk-1-2020.txt))`);
lines.push(`- **SPDX-FileCopyrightText:** 2020 Splunk, Inc. <sales@splunk.com>`);
lines.push(`- **Absorbed sourcetypes:** \`isc:bind:query\`, \`isc:bind:queryerror\`, \`isc:bind:lameserver\`, \`isc:bind:network\`, \`isc:bind:transfer\``);
lines.push(`- **Absorbed lookups:** \`isc_bind_action.csv\`, \`isc_bind_category.csv\`, \`isc_bind_reply_code.csv\`, \`isc_bind_severities.csv\``);
lines.push(`- **No source modifications** have been made to the parsing logic. The configs retain their original SPDX headers and structure; only attribution comments were added to identify the absorption boundary.`);
lines.push('');
lines.push(`### Splunk Add-on for Squid Proxy v2.1.0`);
lines.push('');
lines.push(`- **Origin:** <https://splunkbase.splunk.com/app/5159> (archived)`);
lines.push(`- **License:** \`LicenseRef-Splunk-8-2021\` (full text in [\`LICENSES/LicenseRef-Splunk-8-2021.txt\`](LICENSES/LicenseRef-Splunk-8-2021.txt))`);
lines.push(`- **SPDX-FileCopyrightText:** 2021 Splunk, Inc. <sales@splunk.com>`);
lines.push(`- **Absorbed sourcetypes:** \`squid:access\` (the \`squid:access:recommended\` sourcetype was NOT absorbed — see release notes)`);
lines.push(`- **Absorbed lookups:** \`squid_actions_210.csv\`, \`squid_httpstatus.csv\``);
lines.push(`- **One lookup customization:** \`squid_actions_210.csv\` maps the \`TCP_DENIED\`, \`UDP_DENIED\`, \`TCP_SWAPFAIL\`, and \`UDP_INVALID\` vendor_action values to \`denied\` (rather than the upstream \`blocked\` value) for compatibility with the LogServ App's pre-existing Environment Health and Proxy dashboards. This deviates from CIM Proxy data-model standard vocabulary — see release notes for the cost rationale.`);
lines.push('');
lines.push(`---`);
lines.push('');

lines.push(`## Components`);
lines.push('');

for (const rec of records) {
    lines.push(`### ${rec.name}@${rec.version}`);
    lines.push('');
    if (rec.license) lines.push(`- **License:** ${rec.license}`);
    else lines.push(`- **License:** _(not declared in package.json)_`);
    if (rec.repository) lines.push(`- **Repository:** ${rec.repository}`);
    if (rec.homepage) lines.push(`- **Homepage:** ${rec.homepage}`);
    if (rec.author) lines.push(`- **Author:** ${rec.author}`);
    lines.push('');

    if (rec.licenseFiles.length === 0) {
        lines.push(`_(No LICENSE/NOTICE/COPYING file present in the installed package directory.)_`);
        lines.push('');
    } else {
        for (const lf of rec.licenseFiles) {
            const text = readLicenseText(lf.path);
            lines.push(`<details><summary><code>${lf.name}</code></summary>`);
            lines.push('');
            lines.push('```');
            // Defang any embedded triple-backticks so they don't
            // close the fence early. Zero-width-space sentinel keeps
            // the text legible without producing a visible glyph.
            lines.push(text.replace(/```/g, '​```​'));
            lines.push('```');
            lines.push('');
            lines.push(`</details>`);
            lines.push('');
        }
    }
    lines.push(`---`);
    lines.push('');
}

const outBytes = Buffer.from(lines.join('\n'), 'utf8');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, outBytes);

console.log(`generate-third-party-notices: wrote ${OUT}`);
console.log(`  app: ${APP_NAME} ${APP_VERSION}`);
console.log(`  packages walked: ${counts.walked}`);
console.log(`  with license field: ${counts.withLicense}`);
console.log(`  with bundled license text: ${counts.withLicenseText}`);
console.log(`  without license field: ${counts.noLicense}`);
if (counts.parseError > 0) {
    console.log(`  unparseable package.json (skipped): ${counts.parseError}`);
}
console.log(`  output size: ${outBytes.length.toLocaleString()} bytes (${(outBytes.length / 1024).toFixed(1)} KiB)`);

function parseArgs(argv) {
    const out = { _positional: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                out[key] = next;
                i++;
            } else {
                out[key] = true;
            }
        } else if (out._positional === null) {
            out._positional = a;
        }
    }
    return out;
}

function escapePipe(s) {
    return String(s).replace(/\|/g, '\\|');
}
