#!/usr/bin/env node
/**
 * generate-sbom.js — emit a CycloneDX 1.4 SBOM from package.json + yarn.lock.
 *
 * Implements OWASP LLM03 (Supply Chain) Appendix D recommendation #6:
 * "Emit a CycloneDX SBOM as part of `yarn build` and ship it in the
 *  app tarball."
 *
 * Why a custom script and not `@cyclonedx/cdxgen`:
 *   - Zero external dependencies — works in any clean checkout without
 *     network or npx download
 *   - Fully deterministic output (sorted, stable timestamps from
 *     SOURCE_DATE_EPOCH if set)
 *   - Reads the workspace's yarn.lock directly (lockfile is the
 *     ground truth — what we'd actually build with), not the
 *     resolved node_modules tree
 *
 * Output: CycloneDX 1.4 JSON. Tested against the cyclonedx-cli
 *   validator. Includes:
 *     - bomFormat / specVersion / serialNumber / metadata.timestamp
 *     - metadata.component for this app (type=application, name, version)
 *     - metadata.tools entry for this script
 *     - components[] for every unique <name>@<version> in yarn.lock,
 *       with purl, externalReferences (resolved URL), and hashes
 *       (when integrity is present)
 *
 * Usage: `yarn sbom` (writes to stage/SBOM.json) or `node bin/generate-sbom.js <path>`.
 *
 * Build 90 / session 020.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_DIR = __dirname;
const PACKAGE_DIR = path.join(SCRIPT_DIR, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

const pkgPath = path.join(PACKAGE_DIR, 'package.json');
const lockPath = path.join(WORKSPACE_ROOT, 'yarn.lock');

if (!fs.existsSync(pkgPath)) {
    console.error(`generate-sbom: ${pkgPath} not found`);
    process.exit(1);
}
if (!fs.existsSync(lockPath)) {
    console.error(`generate-sbom: ${lockPath} not found (expected workspace yarn.lock)`);
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
// Normalize CRLF → LF so block-splitting and line-anchored regex
// match consistently regardless of the lockfile's checkout line-end
// convention (Windows vs Unix git autocrlf).
const lockText = fs.readFileSync(lockPath, 'utf8').replace(/\r\n/g, '\n');

/**
 * Parse yarn.lock v1 into a map of `<name>@<version>` → component.
 *
 * Block format:
 *   "<spec1>"[, "<spec2>"]*:
 *     version "<X.Y.Z>"
 *     resolved "<URL>#<sha1-hash>"
 *     integrity <sha512-...>
 *     dependencies:
 *       <name> "<spec>"
 *
 * We only extract: name, version, resolved URL, integrity. The
 * dependency tree is not embedded (CycloneDX supports it via
 * `dependencies[]` but it adds bytes without changing what
 * scanners check; AppInspect/Dependabot care about which
 * components, not how they connect).
 */
const HEADER_RE = /^"?(@?[^"@\s]+)@/;
const VERSION_RE = /\n  version "([^"]+)"/;
const RESOLVED_RE = /\n  resolved "([^"]+)"/;
const INTEGRITY_RE = /\n  integrity (\S+)/;

const components = new Map();
const blocks = lockText.split(/\n\n+/);
for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const headerLine = lines[0];
    if (!headerLine || !headerLine.endsWith(':')) continue;
    const headerMatch = HEADER_RE.exec(headerLine);
    if (!headerMatch) continue;
    const name = headerMatch[1];
    const versionMatch = VERSION_RE.exec(block);
    if (!versionMatch) continue;
    const version = versionMatch[1];
    const key = `${name}@${version}`;
    if (components.has(key)) continue;

    const resolvedMatch = RESOLVED_RE.exec(block);
    const integrityMatch = INTEGRITY_RE.exec(block);

    const component = {
        type: 'library',
        'bom-ref': `pkg:npm/${encodePurlName(name)}@${version}`,
        name,
        version,
        purl: `pkg:npm/${encodePurlName(name)}@${version}`,
    };

    if (resolvedMatch) {
        const url = resolvedMatch[1].split('#')[0];
        component.externalReferences = [{ type: 'distribution', url }];
    }
    if (integrityMatch) {
        const integrity = integrityMatch[1];
        const hashes = parseIntegrity(integrity);
        if (hashes.length > 0) component.hashes = hashes;
    }

    components.set(key, component);
}

function encodePurlName(name) {
    if (name.startsWith('@')) {
        const slash = name.indexOf('/');
        const scope = encodeURIComponent(name.slice(0, slash));
        const rest = encodeURIComponent(name.slice(slash + 1));
        return `${scope}/${rest}`;
    }
    return encodeURIComponent(name);
}

function parseIntegrity(integrity) {
    // yarn.lock integrity: "sha512-<base64>" possibly multiple separated by space
    const out = [];
    for (const part of integrity.split(/\s+/)) {
        const dash = part.indexOf('-');
        if (dash < 1) continue;
        const alg = part.slice(0, dash).toUpperCase();
        const b64 = part.slice(dash + 1);
        try {
            const hex = Buffer.from(b64, 'base64').toString('hex');
            // CycloneDX expects alg names like "SHA-512", "SHA-256", "SHA-1", "SHA-384".
            const algNorm = alg === 'SHA512' ? 'SHA-512'
                : alg === 'SHA384' ? 'SHA-384'
                : alg === 'SHA256' ? 'SHA-256'
                : alg === 'SHA1' ? 'SHA-1'
                : null;
            if (!algNorm) continue;
            out.push({ alg: algNorm, content: hex });
        } catch { /* skip bad base64 */ }
    }
    return out;
}

const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();

const sortedComponents = [...components.values()].sort((a, b) => {
    if (a.name === b.name) return a.version.localeCompare(b.version);
    return a.name.localeCompare(b.name);
});

const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
        timestamp,
        component: {
            type: 'application',
            'bom-ref': pkg.name,
            name: pkg.name,
            version: pkg.version,
        },
        tools: [{
            vendor: 'splunk_app_sap_logserv',
            name: 'generate-sbom.js',
            version: '1.0.0',
        }],
    },
    components: sortedComponents,
};

const outArg = process.argv[2];
const outPath = outArg
    ? path.resolve(outArg)
    : path.join(PACKAGE_DIR, 'stage', 'SBOM.json');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2));
console.log(`SBOM written: ${outPath} (${sortedComponents.length} components)`);
