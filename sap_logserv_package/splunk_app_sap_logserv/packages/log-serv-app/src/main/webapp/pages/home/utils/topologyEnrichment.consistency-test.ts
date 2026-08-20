/**
 * Build-time consistency test for the IP-node enrichment merge + guards
 * (build 329, session 112).
 *
 * What it pins: buildEnrichmentIndex is the ONLY place the ratified
 * suppress-over-guess decisions live — per-IP hostname uniqueness (after
 * short-vs-FQDN normalization) and the crowd guard (a normalized name
 * claimed by more than ENRICHMENT_HOSTNAME_CROWD_MAX distinct IPs renders
 * for none of them). The conf side (the aggregate's single-pipeline shape,
 * the in-SPL Windows self-guard) is section 3r of bin/check-diagnostics.js;
 * neither half can drift alone.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */

// Standalone script, not a module — see session-085 sticky #4.
export {};

const eProc = process as unknown as {
    stderr: { write(s: string): void };
    exit(code: number): never;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const enrMod = require('../topology/enrichment') as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Row {
    ip?: unknown;
    evidence_source?: unknown;
    hostnames?: unknown;
    users?: unknown;
    last_seen?: unknown;
}
interface Entry {
    ip: string;
    hostname: string | null;
    hostnameSources: string[];
    users: { name: string; sources: string[] }[];
    userCount: number;
    lastSeen: number;
}

const buildEnrichmentIndex = enrMod.buildEnrichmentIndex as (rows: Row[]) => Map<string, Entry>;
const nodeUserLine = enrMod.nodeUserLine as (e: Entry) => string | null;
const groupUsersBySource = enrMod.groupUsersBySource as (
    e: Entry,
) => { source: string; label: string; names: string[] }[];
const normalizeHostname = enrMod.normalizeHostname as (raw: string) => string;
const CROWD_MAX = enrMod.ENRICHMENT_HOSTNAME_CROWD_MAX as number;

let eFailures = 0;
let eChecks = 0;
const check = (name: string, cond: boolean): void => {
    eChecks += 1;
    if (!cond) {
        eFailures += 1;
        eProc.stderr.write(`topologyEnrichment FAIL: ${name}\n`);
    }
};

/* ---- the exported constant: literal pin + everything below derives the
 *      boundary from it (session-098 rule: export + pin + boundary both
 *      directions). ---- */
check('CROWD_MAX literal pin (2 = the multi-NIC allowance)', CROWD_MAX === 2);

/* ---- normalizeHostname ---- */
check('normalize: FQDN -> lowercased first label', normalizeHostname('HEC53V052470.sin.hec.xsd-vlab.com') === 'hec53v052470');
check('normalize: bare name passes through lowercased', normalizeHostname('OSP') === 'osp');
check('normalize: trims whitespace', normalizeHostname('  host1.example.com ') === 'host1');
check('normalize: empty stays empty', normalizeHostname('') === '');

/* ---- short-vs-FQDN merge (the live 10.186.74.11 shape) ---- */
{
    const idx = buildEnrichmentIndex([
        {
            ip: '10.186.74.11',
            evidence_source: 'hana_audit',
            hostnames: ['hec53v052470', 'hec53v052470.sin.hec.xsd-vlab.com'],
            users: ['DDIC', 'xciadm'],
            last_seen: '1787066797.396179',
        },
    ]);
    const e = idx.get('10.186.74.11');
    check('fqdn-merge: entry exists', !!e);
    check('fqdn-merge: two raw forms collapse to ONE candidate and resolve', e?.hostname === 'hec53v052470');
    check('fqdn-merge: display form is the SHORT one', e?.hostname?.indexOf('.') === -1);
    check('fqdn-merge: sources carried', JSON.stringify(e?.hostnameSources) === JSON.stringify(['hana_audit']));
    check('fqdn-merge: lastSeen parsed from string epoch', Math.floor(e?.lastSeen ?? 0) === 1787066797);
}

/* ---- per-IP multi-candidate suppression (guard 1) ---- */
{
    const idx = buildEnrichmentIndex([
        { ip: '1.1.1.1', evidence_source: 'hana_audit', hostnames: 'alpha', users: 'u1', last_seen: 1 },
        { ip: '1.1.1.1', evidence_source: 'windows', hostnames: 'beta', users: 'u1', last_seen: 2 },
    ]);
    const e = idx.get('1.1.1.1');
    check('guard1: two DIFFERENT normalized names -> hostname suppressed', e?.hostname === null);
    check('guard1: users survive the hostname suppression', e?.userCount === 1);
}

/* ---- crowd guard boundary, both directions (guard 2) ---- */
{
    const claimants = (n: number): Row[] => {
        const rows: Row[] = [];
        for (let i = 0; i < n; i += 1) {
            rows.push({ ip: `10.0.0.${i + 1}`, evidence_source: 'hana_audit', hostnames: 'shared', last_seen: 1 });
        }
        return rows;
    };
    const atMax = buildEnrichmentIndex(claimants(CROWD_MAX));
    check(`guard2: claimed by exactly CROWD_MAX (${CROWD_MAX}) -> shown on each`,
        atMax.get('10.0.0.1')?.hostname === 'shared' && atMax.get(`10.0.0.${CROWD_MAX}`)?.hostname === 'shared');
    const overMax = buildEnrichmentIndex(claimants(CROWD_MAX + 1));
    let anyShown = false;
    overMax.forEach((e) => { if (e.hostname !== null) anyShown = true; });
    check('guard2: claimed by CROWD_MAX+1 -> suppressed on ALL claimants', !anyShown);
    check('guard2: crowd-suppressed hostname-only rows produce NO entry',
        overMax.size === 0);
}

/* ---- crowd counts ALL candidates, including an ambiguous claimant ---- */
{
    // IP A claims {shared, other} (ambiguous itself); B and C claim {shared}.
    // shared is claimed by 3 > CROWD_MAX -> suppressed for B and C too.
    const idx = buildEnrichmentIndex([
        { ip: '2.0.0.1', evidence_source: 'hana_audit', hostnames: ['shared', 'other'], users: 'a', last_seen: 1 },
        { ip: '2.0.0.2', evidence_source: 'hana_audit', hostnames: 'shared', users: 'b', last_seen: 1 },
        { ip: '2.0.0.3', evidence_source: 'windows', hostnames: 'shared', users: 'c', last_seen: 1 },
    ]);
    check('guard2: ambiguous claimant still counts into the crowd',
        idx.get('2.0.0.2')?.hostname === null && idx.get('2.0.0.3')?.hostname === null);
}

/* ---- the demo-artifact replay: hec53v052422 claimed by a crowd ---- */
{
    const rows: Row[] = [
        { ip: '10.186.74.8', evidence_source: 'hana_audit', hostnames: 'hec53v052422', users: 'xcjadm', last_seen: 10 },
        { ip: '147.204.100.134', evidence_source: 'hana_audit', hostnames: 'hec53v052422', last_seen: 5 },
        { ip: '147.204.102.84', evidence_source: 'hana_audit', hostnames: 'hec53v052422', last_seen: 6 },
    ];
    const idx = buildEnrichmentIndex(rows);
    check('demo-replay: the crowd name renders for NO claimant (accepted collateral)',
        idx.get('10.186.74.8')?.hostname === null);
    check('demo-replay: the user-bearing claimant keeps its users entry',
        idx.get('10.186.74.8')?.userCount === 1 && idx.get('10.186.74.8')?.users[0].name === 'xcjadm');
    check('demo-replay: hostname-only crowd claimants get NO entry',
        !idx.has('147.204.100.134') && !idx.has('147.204.102.84'));
}

/* ---- case-insensitive user dedupe + cross-source union ---- */
{
    const idx = buildEnrichmentIndex([
        { ip: '3.0.0.1', evidence_source: 'windows', users: ['XCPADM', 'sqladmin'], last_seen: 1 },
        { ip: '3.0.0.1', evidence_source: 'ssh', users: 'xcpadm', last_seen: 2 },
    ]);
    const e = idx.get('3.0.0.1');
    check('users: case-insensitive dedupe across sources', e?.userCount === 2);
    const xcp = e?.users.find((u) => u.name.toLowerCase() === 'xcpadm');
    check('users: display form = first-seen form', xcp?.name === 'XCPADM');
    check('users: source union in SOURCE_ORDER', JSON.stringify(xcp?.sources) === JSON.stringify(['windows', 'ssh']));
    check('users: name-sorted list', JSON.stringify(e?.users.map((u) => u.name.toLowerCase())) === JSON.stringify(['sqladmin', 'xcpadm']));
}

/* ---- nodeUserLine (ratified decision 1: single name, else a count) ---- */
{
    const idx = buildEnrichmentIndex([
        { ip: '4.0.0.1', evidence_source: 'sapstartsrv', users: 'sapadm', last_seen: 1 },
        { ip: '4.0.0.2', evidence_source: 'windows', users: ['a', 'b', 'c'], last_seen: 1 },
        { ip: '4.0.0.3', evidence_source: 'hana_audit', hostnames: 'solo', last_seen: 1 },
    ]);
    check('nodeUserLine: exactly one user -> the name', nodeUserLine(idx.get('4.0.0.1')!) === 'sapadm');
    check('nodeUserLine: several -> the count', nodeUserLine(idx.get('4.0.0.2')!) === '3 users');
    check('nodeUserLine: none -> null', nodeUserLine(idx.get('4.0.0.3')!) === null);
    check('hostname-only entry still exists (the 4.0.0.3 shape)', idx.get('4.0.0.3')?.hostname === 'solo');
}

/* ---- groupUsersBySource (Overview row, decision 2) ---- */
{
    const idx = buildEnrichmentIndex([
        { ip: '5.0.0.1', evidence_source: 'ssh', users: 'shareduser', last_seen: 1 },
        { ip: '5.0.0.1', evidence_source: 'windows', users: ['shareduser', 'winonly'], last_seen: 1 },
    ]);
    const groups = groupUsersBySource(idx.get('5.0.0.1')!);
    check('groups: SOURCE_ORDER (windows before ssh)', JSON.stringify(groups.map((g) => g.source)) === JSON.stringify(['windows', 'ssh']));
    check('groups: a two-source user appears under BOTH groups',
        groups[0].names.indexOf('shareduser') !== -1 && groups[1].names.indexOf('shareduser') !== -1);
    check('groups: human labels resolved', groups[0].label === 'Windows logons' && groups[1].label === 'SSH sessions');
}

/* ---- sanitize-on-read (world-writable collection) ---- */
{
    const ctrl = String.fromCharCode(7);
    const longName = new Array(300).join('x');
    const idx = buildEnrichmentIndex([
        { ip: '6.0.0.1', evidence_source: 'windows', users: [`bad${ctrl}user`, 'gooduser'], hostnames: longName, last_seen: 1 },
        { ip: '<script>', evidence_source: 'windows', users: 'evil', last_seen: 1 },
        { ip: '6.0.0.2', evidence_source: 'hana_audit', users: 42 as unknown as string, hostnames: 'okhost', last_seen: 1 },
        { ip: '6.0.0.3', evidence_source: 'hana_audit', users: 'u<b>', hostnames: 'h1', last_seen: 1 },
    ]);
    const e1 = idx.get('6.0.0.1');
    check('sanitize: control-char user dropped, clean one kept', e1?.userCount === 1 && e1?.users[0].name === 'gooduser');
    check('sanitize: over-length hostname dropped', e1?.hostname === null);
    check('sanitize: angle-bracket ip -> row skipped entirely', !idx.has('<script>'));
    check('sanitize: non-string users tolerated (no crash, none stored)', idx.get('6.0.0.2')?.userCount === 0);
    check('sanitize: angle-bracket user dropped', idx.get('6.0.0.3')?.userCount === 0);
    check('sanitize: hostname on the angle-bracket-user row still resolves', idx.get('6.0.0.3')?.hostname === 'h1');
}

/* ---- KV multivalue round-trip shapes (string vs array) ---- */
{
    const idx = buildEnrichmentIndex([
        { ip: '7.0.0.1', evidence_source: 'ssh', users: 'single', last_seen: 3 },
        { ip: '7.0.0.1', evidence_source: 'windows', users: ['a', 'single'], last_seen: 9 },
    ]);
    const e = idx.get('7.0.0.1');
    check('mv-shapes: plain-string and array users both parsed', e?.userCount === 2);
    check('mv-shapes: lastSeen = max across rows', e?.lastSeen === 9);
}

if (eFailures > 0) {
    eProc.stderr.write(`topologyEnrichment.consistency-test: ${eFailures} of ${eChecks} checks FAILED\n`);
    eProc.exit(1);
}
console.log(`topologyEnrichment.consistency-test: OK (${eChecks} checks)`);
eProc.exit(0);
