#!/usr/bin/env node
/**
 * generate_third_party_notices.js — emit THIRD-PARTY-NOTICES.md from
 * a yarn-resolved node_modules tree.
 *
 * Walks every package directory under <node_modules>, reads its
 * package.json (name / version / license / repository / homepage /
 * author), reads any LICENSE / LICENSE.md / LICENSE.txt / NOTICE /
 * COPYING files in the package directory, and emits one Markdown
 * section per package sorted by name.
 *
 * Output is deterministic (sorted, no timestamps in body) so diffing
 * across releases highlights real package additions/removals/version
 * changes instead of cosmetic ordering noise.
 *
 * Usage:
 *   node generate_third_party_notices.js \
 *     --node-modules <path> \
 *     --out <path-to-THIRD-PARTY-NOTICES.md> \
 *     --app-name "Splunk for SAP LogServ" \
 *     --app-version 0.0.5.0
 *
 * Session 032 / Task A — one-off generation for the v0.0.5.0
 * GitHub release. Same script is promoted into v0.1.1's bin/ for
 * Task B (auto-refresh on yarn build).
 */

const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const NODE_MODULES = path.resolve(args['node-modules']);
const OUT = path.resolve(args.out);
const APP_NAME = args['app-name'] || 'Splunk for SAP LogServ';
const APP_VERSION = args['app-version'] || 'unknown';

if (!fs.existsSync(NODE_MODULES)) {
    console.error(`generate_third_party_notices: node_modules dir not found: ${NODE_MODULES}`);
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
 *     yarn flattens dependencies, so a nested node_modules indicates
 *     a peer-dep version conflict — those nested packages would be
 *     duplicates of top-level entries, double-counting them inflates
 *     the notices file)
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
        // Try UTF-8 first; if it has a BOM strip it.
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

// Emit Markdown.
const lines = [];
lines.push(`# Third-Party Software Notices and Information`);
lines.push('');
lines.push(`This document lists open-source software components included in **${APP_NAME}** version **${APP_VERSION}**.`);
lines.push('');
lines.push(`Each entry below was derived from the package's \`package.json\` and any LICENSE / NOTICE / COPYING files bundled in the package's installed directory under \`node_modules/\`.`);
lines.push('');
lines.push(`Per the licenses below, attribution is preserved. No source modifications have been made to any third-party component bundled with this app.`);
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
            // Strip any embedded triple-backticks in the license text
            // so they don't terminate the fence early. Replace with
            // an HTML-escape style sentinel so the text remains
            // legible.
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

console.log(`generate_third_party_notices: wrote ${OUT}`);
console.log(`  packages walked: ${counts.walked}`);
console.log(`  with license field: ${counts.withLicense}`);
console.log(`  with bundled license text: ${counts.withLicenseText}`);
console.log(`  without license field: ${counts.noLicense}`);
if (counts.parseError > 0) {
    console.log(`  unparseable package.json (skipped): ${counts.parseError}`);
}
console.log(`  output size: ${outBytes.length.toLocaleString()} bytes (${(outBytes.length / 1024).toFixed(1)} KiB)`);

function parseArgs(argv) {
    const out = {};
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
        }
    }
    return out;
}

function escapePipe(s) {
    return String(s).replace(/\|/g, '\\|');
}
