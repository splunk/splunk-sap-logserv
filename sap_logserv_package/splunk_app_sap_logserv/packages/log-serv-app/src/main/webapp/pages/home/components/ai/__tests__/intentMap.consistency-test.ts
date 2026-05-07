/**
 * Build-time consistency test: intent map ↔ savedsearches.conf.
 *
 * Asserts that for every entry in `default/data/mcp/logserv_intent_map.json`:
 *   - `savedSearch` references a stanza that exists in
 *     `default/savedsearches.conf`
 *   - `spl` exactly matches the `search =` line of that stanza
 *     (after Splunk-side conf-file unwrapping: line continuations,
 *     trimmed leading/trailing whitespace).
 *
 * This catches the threat-model issue called out in §9.1 of the design
 * doc: "Canned prompt's pre-baked SPL drifts from the saved-search
 * version (build-time consistency)". CI fails on drift.
 *
 * Run with: `npx ts-node --transpile-only intentMap.consistency-test.ts`
 *
 * No dev-dependency on @types/node — Node globals are declared inline
 * to avoid bloating the project's tsconfig.
 */

/* eslint-disable no-console */

declare const require: (id: string) => unknown;
declare const __dirname: string;

interface FsModule {
    readFileSync(path: string, encoding: string): string;
}
interface PathModule {
    resolve(...parts: string[]): string;
    join(...parts: string[]): string;
}

const fs = require('fs') as FsModule;
const path = require('path') as PathModule;

interface IntentMapPrompt {
    id: string;
    pack: 'sap_basis' | 'security' | 'operations';
    label: string;
    description: string;
    savedSearch: string;
    spl: string;
    renderHint: 'table' | 'timechart' | 'kpi' | 'pie';
    /** Optional companion chart for table-primary entries (build 74+). */
    chartHint?: 'timechart' | 'kpi' | 'pie';
    /** Optional explicit palette for the chart (build 139+). */
    chartPalette?: 'errors' | 'errors-2' | 'errors-3' | 'volume' | 'auth' | 'status' | 'categorical' | 'neutral';
    /** Optional interpretation + next-step suggestions (build 140+).
     *  Build 141: nextSteps entries can be plain strings OR link
     *  objects `{text, savedSearch?, spl?}`. */
    interpretation?: string;
    nextSteps?: Array<string | { text: string; savedSearch?: string; spl?: string }>;
    /** Optional related-dashboard mapping (build 156 / session 027).
     *  Single string for one dashboard, array for cross-cutting prompts
     *  that span multiple OOTB dashboards. Slugs must match an entry in
     *  `routes/dashboardRegistry.ts`. The chat citation parser auto-appends
     *  an "Open dashboard ↗" link sibling to each `[→ saved_search]`
     *  citation, and the right-pane tile renders the same link in its
     *  title-row actions slot. */
    dashboard?: string | string[];
}

interface IntentMap {
    version: string;
    description?: string;
    packs: Record<string, { label: string; description: string }>;
    prompts: IntentMapPrompt[];
}

// Path traversal from this test file (src/main/webapp/pages/home/components/ai/__tests__/)
// up to src/main/, then forward into resources/splunk/default/.
const SPLUNK_RESOURCES = path.resolve(
    __dirname,  // .../components/ai/__tests__
    '..',       // .../components/ai
    '..',       // .../components
    '..',       // .../home
    '..',       // .../pages
    '..',       // .../webapp
    '..',       // .../main
    'resources',
    'splunk',
    'default',
);

const intentMapPath = path.join(SPLUNK_RESOURCES, 'data', 'mcp', 'logserv_intent_map.json');
const savedSearchesPath = path.join(SPLUNK_RESOURCES, 'savedsearches.conf');

const intentMap: IntentMap = JSON.parse(fs.readFileSync(intentMapPath, 'utf8')) as IntentMap;
const savedSearchesText = fs.readFileSync(savedSearchesPath, 'utf8');

const savedSearches = parseConf(savedSearchesText);

/**
 * Valid dashboard slugs — kept in sync with `routes/dashboardRegistry.ts`.
 * Hardcoded here rather than imported because this test is run as a
 * standalone ts-node script (no JSX/webpack toolchain available).
 * Build 156 / session 027.
 */
const VALID_DASHBOARD_SLUGS = new Set([
    'environment-health',
    'integration-topology',
    'abap-security',
    'abap-operations',
    'work-process-performance',
    'hana-audit',
    'hana-trace',
    'sap-services',
    'sap-router',
    'cloud-connector',
    'web-dispatcher',
    'web-api-performance',
    'network-perimeter',
    'cross-stack-authentication',
    'change-config',
    'data-pipeline-overview',
    'dns-analytics',
    'linux',
    'windows',
    'proxy',
    'host-details',
]);

console.log(`intentMap version: ${intentMap.version}`);
console.log(`prompts in registry: ${intentMap.prompts.length}`);
console.log(`stanzas in savedsearches.conf: ${Object.keys(savedSearches).length}`);

let failed = 0;

// Shape sanity
for (const p of intentMap.prompts) {
    if (!p.id || !p.id.match(/^[a-z_]+\.[a-z0-9_]+$/)) {
        failed++;
        console.error(`FAIL malformed prompt id: ${JSON.stringify(p.id)}`);
    }
    if (!['sap_basis', 'security', 'operations'].includes(p.pack)) {
        failed++;
        console.error(`FAIL unknown pack ${p.pack} in ${p.id}`);
    }
    if (!intentMap.packs[p.pack]) {
        failed++;
        console.error(`FAIL pack ${p.pack} (used by ${p.id}) not declared in packs map`);
    }
    if (!p.savedSearch.match(/^logserv_[a-z0-9_]+$/)) {
        failed++;
        console.error(`FAIL savedSearch name doesn't match pattern: ${p.savedSearch}`);
    }
    if (!p.label || p.label.length < 8) {
        failed++;
        console.error(`FAIL label too short or missing: ${p.id}`);
    }
    if (!p.description || p.description.length < 30) {
        failed++;
        console.error(`FAIL description too short: ${p.id} (${p.description?.length ?? 0} chars)`);
    }
    if (p.chartPalette !== undefined) {
        const allowed = new Set([
            'errors', 'errors-2', 'errors-3', 'volume', 'auth', 'status', 'categorical', 'neutral',
        ]);
        if (!allowed.has(p.chartPalette)) {
            failed++;
            console.error(`FAIL chartPalette ${JSON.stringify(p.chartPalette)} on ${p.id} not one of ${Array.from(allowed).join(', ')}`);
        }
    }
    if (p.interpretation !== undefined) {
        if (typeof p.interpretation !== 'string' || p.interpretation.length < 30) {
            failed++;
            console.error(`FAIL interpretation on ${p.id}: must be a string of at least 30 chars (${typeof p.interpretation === 'string' ? p.interpretation.length : 'not-a-string'})`);
        }
    }
    if (p.dashboard !== undefined) {
        const slugs: string[] = Array.isArray(p.dashboard) ? p.dashboard : [p.dashboard];
        if (slugs.length === 0) {
            failed++;
            console.error(`FAIL dashboard on ${p.id}: array form must have at least one slug`);
        }
        for (const slug of slugs) {
            if (typeof slug !== 'string' || slug.length === 0) {
                failed++;
                console.error(`FAIL dashboard on ${p.id}: each slug must be a non-empty string`);
            } else if (!VALID_DASHBOARD_SLUGS.has(slug)) {
                failed++;
                console.error(`FAIL dashboard on ${p.id}: slug "${slug}" not found in dashboardRegistry`);
            }
        }
        // Reject duplicate slugs in array form
        const seen = new Set<string>();
        for (const slug of slugs) {
            if (seen.has(slug)) {
                failed++;
                console.error(`FAIL dashboard on ${p.id}: duplicate slug "${slug}" in array`);
            }
            seen.add(slug);
        }
    }
    if (p.nextSteps !== undefined) {
        if (!Array.isArray(p.nextSteps)) {
            failed++;
            console.error(`FAIL nextSteps on ${p.id}: must be an array`);
        } else {
            for (let i = 0; i < p.nextSteps.length; i += 1) {
                const s = p.nextSteps[i];
                if (typeof s === 'string') {
                    if (s.length < 10) {
                        failed++;
                        console.error(`FAIL nextSteps[${i}] on ${p.id}: plain string must be ≥10 chars`);
                    }
                } else if (typeof s === 'object' && s !== null) {
                    const obj = s as { text?: unknown; savedSearch?: unknown; spl?: unknown };
                    if (typeof obj.text !== 'string' || obj.text.length < 10) {
                        failed++;
                        console.error(`FAIL nextSteps[${i}] on ${p.id}: link object must have text string ≥10 chars`);
                    }
                    const hasSaved = typeof obj.savedSearch === 'string' && obj.savedSearch.length > 0;
                    const hasSpl = typeof obj.spl === 'string' && obj.spl.length > 0;
                    if (!hasSaved && !hasSpl) {
                        failed++;
                        console.error(`FAIL nextSteps[${i}] on ${p.id}: link object must have savedSearch OR spl`);
                    }
                    if (hasSaved && hasSpl) {
                        failed++;
                        console.error(`FAIL nextSteps[${i}] on ${p.id}: link object cannot have BOTH savedSearch AND spl`);
                    }
                } else {
                    failed++;
                    console.error(`FAIL nextSteps[${i}] on ${p.id}: must be string or object`);
                }
            }
        }
    }
}

// Reverse pass: nextStep links that reference a savedSearch must point at
// a real saved search (one that exists in this same intent map). Catches
// dangling references at build time. Build 141.
const intentMapSavedSearches = new Set(intentMap.prompts.map((pp) => pp.savedSearch));
for (const p of intentMap.prompts) {
    if (!Array.isArray(p.nextSteps)) continue;
    for (let i = 0; i < p.nextSteps.length; i += 1) {
        const s = p.nextSteps[i];
        if (typeof s === 'object' && s !== null) {
            const ref = (s as { savedSearch?: string }).savedSearch;
            if (typeof ref === 'string' && !intentMapSavedSearches.has(ref)) {
                failed++;
                console.error(`FAIL nextSteps[${i}] on ${p.id}: savedSearch reference "${ref}" not found in intent map`);
            }
        }
    }
}

// Cross-reference
const seenSavedSearchNames = new Set<string>();
for (const p of intentMap.prompts) {
    seenSavedSearchNames.add(p.savedSearch);
    const stanza = savedSearches[p.savedSearch];
    if (!stanza) {
        failed++;
        console.error(
            `FAIL prompt ${p.id} references savedSearch ${p.savedSearch} which does not exist in savedsearches.conf`,
        );
        continue;
    }
    const stanzaSpl = stanza.search?.trim();
    const promptSpl = p.spl.trim();
    if (stanzaSpl !== promptSpl) {
        failed++;
        console.error(`FAIL SPL drift for ${p.savedSearch}:`);
        console.error(`  intent map: ${promptSpl.substring(0, 120)}`);
        console.error(`  conf file:  ${stanzaSpl?.substring(0, 120) ?? '(missing search field)'}`);
    }
}

// Reverse direction: every saved search starting with `logserv_` should be referenced
for (const stanzaName of Object.keys(savedSearches)) {
    if (!stanzaName.startsWith('logserv_')) continue;
    if (!seenSavedSearchNames.has(stanzaName)) {
        failed++;
        console.error(
            `FAIL savedsearches.conf has [${stanzaName}] but no prompt in the intent map references it`,
        );
    }
}

if (failed > 0) {
    console.error(`\n${failed} consistency checks failed.`);
    throw new Error(`intentMap consistency: ${failed} checks failed`);
} else {
    console.log(`\nAll consistency checks passed.`);
}

/**
 * Minimal Splunk .conf parser. Handles `[stanza]` headers + `key = value`
 * lines. Comments (#) and blank lines ignored. Line continuations (\)
 * NOT supported — Splunk allows them but our SPL is single-line.
 */
function parseConf(text: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    let current: Record<string, string> | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            const stanzaName = line.slice(1, -1).trim();
            current = {};
            out[stanzaName] = current;
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (current) current[key] = value;
    }
    return out;
}

export {};
