/**
 * Build-time consistency test for the host names (aliases) of App build 400:
 * utils/hostAlias.ts, the pure module every alias on screen goes through.
 *
 * What it pins:
 *  - L: the limits (MAX_ROWS 5000, match value 255, alias 64, description 256);
 *  - N: normalizeHostValue (trim, lower case, ONE trailing dot);
 *  - I: parseIp - strict IPv4 and IPv6 (RFC 4291 text forms, RFC 5952 output),
 *    IPv4-mapped IPv6 folded to IPv4, and what is NOT an IP (URLs, host:port,
 *    "/", spaces, zone ids, brackets, 1.2.3.256);
 *  - A: isAliasableValue / keyForMatchValue (placeholders, URLs, host:port and
 *    digit-and-dot values that are not IPv4 carry no alias);
 *  - R: resolveAlias, every rule (a)-(e) in order, the ambiguous short name, an
 *    IP never folded to its first octet, and the order between two rows of
 *    one key;
 *  - S: sanitizeAliasRow and isDeletableKey (control, C1, direction marks, the
 *    invisible format characters and fillers, an alias with nothing that shows,
 *    < >, lengths, bad match values, the derived key; keys with a slash, a
 *    backslash, a percent sign, a question mark, a number sign, a semicolon or a
 *    dot-only path segment are not deletable); updated_at at most 8.64e12 and
 *    isoOfEpoch, which never throws (S9); the characters read by code point, so
 *    every format character (Cf) of any plane is refused inside a word and no
 *    default-ignorable code point shows alone, the tag characters, the
 *    variation selectors supplement and the other astral format controls
 *    included, while an emoji or a CJK extension character stays a character
 *    that shows; the Mongolian selectors and the supplement refused anywhere
 *    in a name (owner decision), and a lone high surrogate never hides the
 *    character after it (S10);
 *  - C: parseAliasCsv (RFC 4180 quoting, embedded commas and line breaks, BOM,
 *    CRLF / LF / blank lines, header order and case, missing header, unknown
 *    columns, an exact repeat skipped with a warning in either order of an
 *    empty and a non-empty description (the accepted row keeps the non-empty
 *    one), conflicting aliases (letter case counts) or descriptions refused
 *    on every line of the host (a repeat skipped before the conflict too, its
 *    warning dropped), MAX_ROWS, invisible characters, U+FFFD from a file not
 *    saved as UTF-8, a semicolon or tab header, quoted or not, a header holding
 *    U+FFFD or a NUL (save as CSV UTF-8), and a column named twice (no hint));
 *  - X: toAliasCsv (header, CRLF, order, quoting, the formula guard, cells led
 *    by a tab, a CR or a space) and the round trip through parseAliasCsv, with
 *    the byte order mark Export writes, and Export's empty template;
 *  - D: aliasDisplayNames (the collision suffixes; distinct raw values always
 *    give distinct names), formatAliasLabel, and aliasHostColumn (a link
 *    graph's host column: one name per distinct host, nodes never merge);
 *  - V: utils/aliasSeries.ts, the per-host charts' series names: none without
 *    a namer (the same array), Splunk's own OTHER and NULL series never named
 *    and never handed to the namer, every series raw when one name starts
 *    with '_', is empty or repeats, or the count is wrong, the values read
 *    under the raw field names, the colour copied to the shown name;
 *  - E: utils/hostAliasEditor.ts, the editor's decisions - adds, renames,
 *    description-only changes, the empty-description merge, capacity counted
 *    over the STORED rows (invalid ones too) plus an import's new rows (its
 *    adds, and a host stored under a foreign key written anew under its own),
 *    an export -> import round trip with nothing to write when no host's rows
 *    conflict (and, for a conflicted host, the name the export holds written
 *    under the host's own key after a question), the form checks,
 *    Save's plan and its question (a row named as removed only when it is),
 *    the preview lists and the questions it asks, the editor's guards (lists
 *    only with no refused line, the tip only while Import is on, the
 *    dashboards' read error only when both reads are done), that the editor
 *    component keeps none of this logic itself, and that it names no IP
 *    address (its examples ship in the bundle AppInspect reads); a Save that
 *    writes to a key no stored row holds is a new row, refused in a full table
 *    (an add over a host stored only under other keys, an edit that moves a
 *    row, the edit of a row whose key cannot be deleted); Save keeps the
 *    description of the row it replaces when the form leaves it empty; a row
 *    of ANOTHER host stored under the key a write uses is replaced, named and
 *    asked about by Save and Import, and adds no row, also when the host's
 *    own row is stored under a foreign key (E17); rows that tie with
 *    different names (conflictedKeys, E18: only the tied names listed, and
 *    Save's question for such a host lists them and says the dashboards use
 *    none of them); the name a host shows once a row is deleted
 *    (nameAfterDelete, E19); the host field's error text (E20); the same rows
 *    in any read order give the same row in effect (ranksBefore), plans,
 *    questions and export (E22, build 401); and the editor's write paths
 *    (E21): Export over the row in effect
 *    with a byte order mark, Save and Import write only the plan's rows, a
 *    delete uses the stored key, an edit writes before it deletes, both read
 *    the table again after the question and write only when the plan over it
 *    is the one asked about, Delete reads the table again after its question
 *    and deletes nothing when the row or the name the host value then shows
 *    changed (deleteStoppedText, lifted from the panel and run with the
 *    panel's sameEntry, planText and conflict texts), a Save stop edits the
 *    row as read, load() marks itself reading before it reads, Refresh reads
 *    the list again, and the texts of a failed read, a header-only file, a
 *    conflict, a partial import and a key that cannot be deleted; the list's
 *    header and rows size every column the same (E23, build 403);
 *  - P: the wiring - the modules stay gate-safe, the provider is mounted once
 *    inside the global Refresh provider in AppShell, keeps one map (and one
 *    context value) for an empty, reordered or unchanged table, keeps loading
 *    and error in a second context only the editor reads, clears the error on
 *    every successful read, DataTable resolves an alias only in its default
 *    cell and only for a flagged column (one line, no compact variant), the hover text of
 *    an aliased cell and line names both ("name - raw"), HostName's line has a
 *    text separator, the raw value gives way before the name (build 403: the
 *    line is cut at its right end), and the copy
 *    handler (copyOnOneLine: a range inside the enclosing cell, or one ending
 *    at the very start of the next cell, copies as one line) sits on the line
 *    and on an aliased DataTable cell (Live Activity's cell: topologyTypes T13);
 *  - Q: the surfaces - the 45 flagged host and IP columns dashboard by
 *    dashboard (plain columns only, none holding a URL, domain, query, user,
 *    SID or sourcetype) and Host Details' SAP Router Peers; a row click gets
 *    the raw row and sorting the raw values; the three host lists keep the raw
 *    value; the three per-host charts (TimeSeriesChart names them through
 *    utils/aliasSeries, P5); the two link graphs through aliasHostColumn; no
 *    name reaches a URL, a stored selection, SPL, onChange or a state setter,
 *    on one line or through variables (Q6 follows a name in the syntax tree,
 *    with the audit's M10 as a known case); the Host filter's search, button,
 *    tick and tooltip (the raw
 *    hosts listed only while names exist); Linux's Top Drop Source (its SPL
 *    unchanged, split in the browser; the card's one-line cut of the name with
 *    the count always in view, and its tooltip, opt-in, Linux the only user);
 *    and the AI
 *    Assistant, the Data Doctor, PanelMeta, the URL builders, the query
 *    filters and every search stay without names, by import (Q9) and by code:
 *    none of them sets a hostAlias flag, names aliasSeries or calls an alias
 *    hook, and outside the dashboards no column carries the flag (Q10).
 *
 * The KV side (the collection's ACL, the writer and reader modules) is
 * utils/kvAcl.consistency-test.ts.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */
// The harness declarations name parameters, which the base rule (not TypeScript-aware) reports as unused.
/* eslint-disable no-unused-vars, no-underscore-dangle */

// Standalone script, not a module.
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');
// A build-time test: typescript is a devDependency on purpose (Q6 follows a name through variables in the syntax tree).
// eslint-disable-next-line import/no-extraneous-dependencies
const ts = require('typescript');
const ha = require('./hostAlias');
const he = require('./hostAliasEditor');
const asr = require('./aliasSeries');

const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let haFailures = 0;
let haChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    haChecks += 1;
    if (!ok) {
        haFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown): string => JSON.stringify(v);
const ch = (code: number): string => String.fromCharCode(code);
const repeat = (s: string, n: number): string => new Array(n + 1).join(s);

/* ---- L the limits ---- */
check('L1 limits', ha.MAX_ROWS === 5000 && ha.MAX_MATCH_LEN === 255 && ha.MAX_ALIAS_LEN === 64 && ha.MAX_DESC_LEN === 256,
    show([ha.MAX_ROWS, ha.MAX_MATCH_LEN, ha.MAX_ALIAS_LEN, ha.MAX_DESC_LEN]));

/* ---- N normalization ---- */
check('N1 trim, lower case, trailing dot', ha.normalizeHostValue('  App01.Example.COM. ') === 'app01.example.com',
    ha.normalizeHostValue('  App01.Example.COM. '));
check('N2 only ONE trailing dot', ha.normalizeHostValue('app01..') === 'app01.', ha.normalizeHostValue('app01..'));
check('N3 not a string or a number', [null, undefined, ['app01'], { a: 1 }, NaN].every((v) => ha.normalizeHostValue(v) === ''),
    'null / undefined / array / object / NaN must normalize to ""');
check('N4 a number', ha.normalizeHostValue(42) === '42', ha.normalizeHostValue(42));

/* ---- I IP addresses ---- */
const IP_CASES: Array<[string, string | null]> = [
    ['192.0.2.10', '192.0.2.10'],
    [' 192.0.2.10 ', '192.0.2.10'],
    ['192.000.002.010', '192.0.2.10'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::1', '::1'],
    ['::', '::'],
    ['1::', '1::'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['fe80:0:0:0:0:0:0:1', 'fe80::1'],
    ['::ffff:192.0.2.10', '192.0.2.10'],
    ['::FFFF:c000:20a', '192.0.2.10'],
    ['0:0:0:0:0:ffff:192.0.2.10', '192.0.2.10'],
    ['64:ff9b::192.0.2.10', '64:ff9b::c000:20a'],
    ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:102:304'],
    ['1.2.3.256', null],
    ['1.2.3', null],
    ['1.2.3.4.5', null],
    ['1..2.3', null],
    ['1.2.3.-4', null],
    ['1234.1.1.1', null],
    ['0010.1.1.1', null],
    ['', null],
    ['2001:db8::1::2', null],
    [':::1', null],
    ['1:2:3:4:5:6:7:8:9', null],
    ['1:2:3:4:5:6:7', null],
    ['12345::1', null],
    ['1:2:3:4::5:6:7:8', null],
    ['g::1', null],
    ['1::2:', null],
    [':1::2', null],
    ['1.2.3.4::', null],
    ['::1.2.3.256', null],
    ['1:2:3:4:5:6:7:1.2.3.4', null],
    ['fe80::1%eth0', null],
    ['[2001:db8::1]', null],
    ['2001:db8::1/64', null],
    ['192.0.2.0/24', null],
    ['http://192.0.2.10/', null],
    ['https://[2001:db8::1]:443/', null],
    ['192.0.2.10:443', null],
    ['app01.example.com:8080', null],
    ['host:8080', null],
    ['abc:def', null],
    ['192.0.2.10 extra', null],
    ['192.0.2. 10', null],
    ['app01', null],
];
IP_CASES.forEach(([input, want]) => {
    const got = ha.parseIp(input);
    check(`I parseIp(${show(input)})`, got === want, `got ${show(got)}, want ${show(want)}`);
});
check('I non-strings', [null, undefined, 3, ['192.0.2.10']].every((v) => ha.parseIp(v) === null), 'must be null');

/* ---- A aliasable values and keys ---- */
const YES = ['app01', 'APP01.example.com', 'app_01.example.com', 'web-01', 'app01.example.com.', '_svc.example.com',
    '192.0.2.10', '2001:db8::1', '::ffff:192.0.2.10', 'a1', repeat('a', 255)];
const NO = ['', '   ', '(none)', '-', '--', 'unknown', 'UNKNOWN', 'none', 'null', 'nil', 'undefined', 'N/A', 'n/a',
    'http://app01.example.com', 'https://192.0.2.10', 'app01.example.com:8080', 'app01 example', 'app01..example.com',
    '.app01', '-app01', 'app01.-', 'app01._', '1.2.3.256', '10', '1.2.3', 'a/b', 'app01;x', 'app01,x', repeat('a', 256),
    'app01\\x', `app${ch(9)}01`];
YES.forEach((v) => check(`A1 aliasable ${show(v.length > 40 ? `${v.slice(0, 12)}...` : v)}`, ha.isAliasableValue(v) === true, 'must be aliasable'));
NO.forEach((v) => check(`A2 not aliasable ${show(v.length > 40 ? `${v.slice(0, 12)}...` : v)}`, ha.isAliasableValue(v) === false,
    'must not be aliasable'));
check('A2 non-strings', [null, undefined, 42, ['app01'], {}].every((v) => ha.isAliasableValue(v) === false), 'must be false');
const KEYS: Array<[string, string | null]> = [
    ['App01.Example.com.', 'app01.example.com'],
    ['  APP01  ', 'app01'],
    ['::FFFF:192.0.2.10', '192.0.2.10'],
    ['192.000.002.010', '192.0.2.10'],
    ['2001:0DB8::0001', '2001:db8::1'],
    ['(none)', null],
    ['app01:80', null],
];
KEYS.forEach(([input, want]) => {
    const got = ha.keyForMatchValue(input);
    check(`A3 keyForMatchValue(${show(input)})`, got === want, `got ${show(got)}, want ${show(want)}`);
});

/* ---- R the match rules ---- */
const ROWS = [
    { match_value: 'app01', alias: 'Billing App' },
    { match_value: 'db01.example.com', alias: 'Billing DB' },
    { match_value: '192.0.2.10', alias: 'Billing App' },
    { match_value: '2001:db8::1', alias: 'Billing v6' },
    { match_value: 'web01.example.com', alias: 'Web A' },
    { match_value: 'web01.example.net', alias: 'Web B' },
    { match_value: 'mail01.example.com', alias: 'Mail' },
    { match_value: 'MAIL01.example.org', alias: 'Mail' },
    { match_value: 'web02', alias: 'W2' },
    { match_value: 'web02.example.com', alias: 'W2 FQDN' },
];
const idx = ha.buildAliasIndex(ROWS);
const r = (raw: unknown): string | null => ha.resolveAlias(idx, raw);
const RULES: Array<[string, unknown, string | null]> = [
    ['(b) exact', 'db01.example.com', 'Billing DB'],
    ['(b) exact, case and trailing dot', 'DB01.EXAMPLE.COM.', 'Billing DB'],
    ['(b) exact short entry', 'APP01', 'Billing App'],
    ['(a) IP exact', '192.0.2.10', 'Billing App'],
    ['(a) IPv4-mapped IPv6', '::ffff:192.0.2.10', 'Billing App'],
    ['(a) IPv6 written another way', '2001:DB8:0::1', 'Billing v6'],
    ['(a) another IP', '192.0.2.11', null],
    ['(c) FQDN covered by its short entry', 'app01.example.com', 'Billing App'],
    ['(c) any domain', 'APP01.other.example', 'Billing App'],
    ['(c) an FQDN entry covers only itself', 'db01.example.org', null],
    ['(c) first label must equal', 'db01x.example.com', null],
    ['(d) short name, the unique FQDN entry', 'db01', 'Billing DB'],
    ['(d) short name, any case', 'DB01', 'Billing DB'],
    ['(d) ambiguous: two FQDN entries, two aliases', 'web01', null],
    ['(b) each ambiguous FQDN still exact', 'web01.example.com', 'Web A'],
    ['(b) the other one', 'web01.example.net', 'Web B'],
    ['(d) two FQDN entries, one alias', 'mail01', 'Mail'],
    ['(b) short entry beats (d)', 'web02', 'W2'],
    ['(b) FQDN entry beats (c)', 'web02.example.com', 'W2 FQDN'],
    ['(c) short entry for another domain', 'web02.example.org', 'W2'],
    ['(e) placeholder', '(none)', null],
    ['(e) dash', '-', null],
    ['(e) unknown', 'unknown', null],
    ['(e) empty', '', null],
    ['(e) null', null, null],
    ['(e) host:port', 'app01:8080', null],
    ['(e) URL', 'http://app01', null],
    ['(e) URL with host', 'https://app01.example.com/x', null],
    ['(e) with a space', 'app01 x', null],
];
RULES.forEach(([label, raw, want]) => {
    const got = r(raw);
    check(`R ${label} ${show(raw)}`, got === want, `got ${show(got)}, want ${show(want)}`);
});
// (a) never folds: an index holding a short "192" and "10" (no valid entry can, so the index is built by hand)
// still gives an IP no alias.
const folded = {
    exact: new Map([['192', 'X'], ['10', 'Y']]),
    short: new Map([['192', 'X'], ['10', 'Y']]),
    byFirstLabel: new Map(),
    size: 2,
};
check('R (a) an IP never folds to its first octet', ha.resolveAlias(folded, '192.0.2.11') === null
    && ha.resolveAlias(folded, '10.0.0.1') === null, `${show(ha.resolveAlias(folded, '192.0.2.11'))}`);
check('R (a) "192" cannot be an entry', ha.sanitizeAliasRow({ match_value: '192', alias: 'X' }) === null, 'must refuse');
check('R empty index', ha.resolveAlias(ha.EMPTY_ALIAS_INDEX, 'app01') === null && ha.EMPTY_ALIAS_INDEX.size === 0, '');
check('R index size', idx.size === ROWS.length, String(idx.size));
check('R invalid rows are skipped',
    ha.buildAliasIndex([{ match_value: '(none)', alias: 'X' }, { match_value: 'ok01', alias: 'bad<' }, null, 'x']).size === 0, '');
{
    const foreign = { _key: 'not-the-key', match_value: 'app09', alias: 'Old' };
    const canonical = { _key: 'app09', match_value: 'app09', alias: 'New' };
    check('R a row under its derived key beats a foreign one, either order',
        ha.resolveAlias(ha.buildAliasIndex([foreign, canonical]), 'app09') === 'New'
        && ha.resolveAlias(ha.buildAliasIndex([canonical, foreign]), 'app09') === 'New', '');
    const sanitized = ha.sanitizeAliasRow(foreign);
    check('R a sanitized foreign row still counts as foreign',
        ha.resolveAlias(ha.buildAliasIndex([canonical, sanitized]), 'app09') === 'New', show(sanitized));
    check('R the later updated_at wins', ha.resolveAlias(ha.buildAliasIndex([
        { match_value: 'APP10', alias: 'A', updated_at: 5 }, { match_value: 'app10', alias: 'B', updated_at: 9 }]), 'app10') === 'B'
        && ha.resolveAlias(ha.buildAliasIndex([
            { match_value: 'app10', alias: 'B', updated_at: 9 }, { match_value: 'APP10', alias: 'A', updated_at: 5 }]), 'app10') === 'B', '');
    check('R two equal rows with different aliases give no alias', ha.resolveAlias(ha.buildAliasIndex([
        { match_value: 'app11', alias: 'A' }, { match_value: 'APP11', alias: 'B' }]), 'app11') === null, '');
    check('R two equal rows with one alias keep it', ha.resolveAlias(ha.buildAliasIndex([
        { match_value: 'app12', alias: 'A' }, { match_value: 'APP12', alias: 'A' }]), 'app12') === 'A', '');
}

/* ---- S sanitize on read ---- */
{
    const ok = ha.sanitizeAliasRow({ _key: 'app01', match_value: ' App01 ', alias: ' Billing ', description: ' d ',
        updated_at: '1700000000', updated_by: 'admin' });
    check('S1 a valid row', same(ok, { _key: 'app01', match_value: 'App01', alias: 'Billing', description: 'd',
        updated_at: 1700000000, updated_by: 'admin' }), show(ok));
    // The invisible format characters and fillers (build 400 review): each draws nothing or a blank.
    const INVISIBLE_CODES = [0xad, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f,
        0xfeff, 0x115f, 0x1160, 0x3164, 0xffa0];
    const BAD_CODES = [0, 7, 9, 10, 13, 27, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
        0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029].concat(INVISIBLE_CODES);
    BAD_CODES.forEach((c) => {
        check(`S2 alias with U+${c.toString(16)}`, ha.sanitizeAliasRow({ match_value: 'app01', alias: `Bil${ch(c)}ling` }) === null,
            'must refuse');
        check(`S2 description with U+${c.toString(16)}`,
            ha.sanitizeAliasRow({ match_value: 'app01', alias: 'Billing', description: `x${ch(c)}y` }) === null, 'must refuse');
    });
    INVISIBLE_CODES.forEach((c) => {
        const u = `U+${c.toString(16)}`;
        check(`S2 hasForbiddenChars finds ${u} first, inside and last`, ha.hasForbiddenChars(`${ch(c)}ab`)
            && ha.hasForbiddenChars(`a${ch(c)}b`) && ha.hasForbiddenChars(`ab${ch(c)}`), 'must find it anywhere');
        check(`S2 an alias of ${u} alone is refused`, ha.sanitizeAliasRow({ match_value: 'app01', alias: ch(c) }) === null
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: `${ch(c)}${ch(c)}${ch(c)}` }) === null, 'must refuse');
        check(`S2 a match value with ${u} is refused`, ha.sanitizeAliasRow({ match_value: `app${ch(c)}01`, alias: 'A' }) === null,
            'must refuse');
    });
    check('S2 ordinary non-ASCII text is fine', ha.sanitizeAliasRow({ match_value: 'app01', alias: `Fakturierung ${ch(0xe4)}` })
        !== null, 'must accept');
    // An alias needs a character that shows: blanks, combining marks, variation selectors and the blank Braille
    // pattern draw nothing alone (each passes trim() and the forbidden characters).
    const BLANK_ALIASES = [ch(0x2800), ch(0x301), `${ch(0x34f)}${ch(0x2800)}`, ch(0xfe0f), `${ch(0x2800)}${ch(0xa0)}${ch(0x2800)}`];
    BLANK_ALIASES.forEach((s) => {
        check(`S2 an alias with nothing that shows ${show(s)} is refused`, ha.hasVisibleChar(s) === false
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: s }) === null, 'must refuse');
    });
    const SHOWN_ALIASES = ['A', `e${ch(0x301)}`, `A${ch(0xfe0f)}`, `${ch(0x2800)}x`, `${ch(0xd83d)}${ch(0xde00)}`, '-', `${ch(0xe4)}`];
    SHOWN_ALIASES.forEach((s) => {
        check(`S2 an alias with a character that shows ${show(s)} is kept`, ha.hasVisibleChar(s) === true
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: s }) !== null, 'must accept');
    });
    check('S2 hasVisibleChar: whitespace and forbidden characters do not show', !ha.hasVisibleChar('')
        && !ha.hasVisibleChar(`  ${ch(0x3000)}${ch(0xa0)}`) && !ha.hasVisibleChar(`${ch(0x200b)}${ch(0x3164)}`), '');
    ['<b>', 'a>b', 'a<b'].forEach((s) => {
        check(`S3 alias ${show(s)}`, ha.sanitizeAliasRow({ match_value: 'app01', alias: s }) === null, 'must refuse');
        check(`S3 description ${show(s)}`, ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', description: s }) === null,
            'must refuse');
    });
    check('S4 alias of 64 is fine, 65 is not', ha.sanitizeAliasRow({ match_value: 'app01', alias: repeat('a', 64) }) !== null
        && ha.sanitizeAliasRow({ match_value: 'app01', alias: repeat('a', 65) }) === null, '');
    check('S4 description of 256 is fine, 257 is not',
        ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', description: repeat('d', 256) }) !== null
        && ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', description: repeat('d', 257) }) === null, '');
    check('S4 match value of 255 is fine, 256 is not', ha.sanitizeAliasRow({ match_value: repeat('a', 255), alias: 'A' }) !== null
        && ha.sanitizeAliasRow({ match_value: repeat('a', 256), alias: 'A' }) === null, '');
    const BAD_ROWS: unknown[] = [null, 'x', 42, [], ['app01', 'A'], {}, { alias: 'A' }, { match_value: 'app01' },
        { match_value: '(none)', alias: 'A' }, { match_value: 'http://x', alias: 'A' }, { match_value: '1.2.3.256', alias: 'A' },
        { match_value: 5, alias: 'A' }, { match_value: 'app01', alias: '' }, { match_value: 'app01', alias: '   ' },
        { match_value: 'app01', alias: 5 }, { match_value: 'app01', alias: ['A'] }, { match_value: 'app01', alias: 'A', description: 5 },
        { match_value: `app01${ch(0x202e)}`, alias: 'A' }];
    BAD_ROWS.forEach((row) => check(`S5 refuses ${show(row)}`, ha.sanitizeAliasRow(row) === null, 'must refuse'));
    const noDesc = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', description: null });
    check('S5 a null or empty description is no description', same(noDesc, { _key: 'app01', match_value: 'app01', alias: 'A' })
        && same(ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', description: '  ' }), noDesc), show(noDesc));
    const f = ha.sanitizeAliasRow({ _key: 'random-key-1', match_value: 'App01.Example.com', alias: 'A' });
    check('S6 a disagreeing stored key: derived _key, stored_key kept', !!f && f._key === 'app01.example.com'
        && f.stored_key === 'random-key-1', show(f));
    check('S6 an agreeing stored key: no stored_key',
        !('stored_key' in (ha.sanitizeAliasRow({ _key: '192.0.2.10', match_value: '::ffff:192.0.2.10', alias: 'A' }) || {})), '');
    const dropped = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', updated_by: `ad${ch(10)}min`, updated_at: 'x' });
    check('S7 a bad updated_by or updated_at is dropped, the row kept', same(dropped, { _key: 'app01', match_value: 'app01',
        alias: 'A' }) && same(ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', updated_at: -1 }), dropped), show(dropped));
    const DEL_NO: unknown[] = ['', '  ', '.', '..', '...', ' . ', ' .. ', null, undefined, 5, `ab${ch(0)}`, repeat('k', 1025),
        'x/..', '../x', 'a/b', 'a%2Fb', '%2e%2e', '%', 'a\\b', '..\\x', 'x\\..', '/', 'a/', `a${ch(0x200b)}b`,
        // A question mark, a number sign or a semicolon would end the path if a proxy decoded the key (SEC-4).
        '?', '#', ';', '?x=1', 'a#b', '..?', 'a;b', `a${String.fromCodePoint(0xe0041)}`];
    DEL_NO.forEach((k) => check(`S8 isDeletableKey(${show(k)}) is false`, ha.isDeletableKey(k) === false, 'an empty, dot,'
        + ' path, percent, query, fragment or parameter key could address the whole collection'));
    ['app01', '192.0.2.10', '2001:db8::1', '.x', '..x', 'x..', 'a.b', 'random-key-1', repeat('k', 1024), 'a b', 'a+b'].forEach((k) => check(
        `S8 isDeletableKey(${show(k.length > 40 ? `${k.slice(0, 12)}...` : k)})`, ha.isDeletableKey(k) === true, 'must be deletable'));

    // S9 updated_at (SEC-1): at most 8.64e12 epoch seconds, the latest time a Date holds; a larger value (written in
    // microseconds or nanoseconds outside the App) is dropped, the row kept, and isoOfEpoch never throws.
    const atMaxEpoch = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', updated_at: 8.64e12 });
    check('S9 updated_at of 8.64e12 is kept', !!atMaxEpoch && atMaxEpoch.updated_at === 8.64e12, show(atMaxEpoch));
    [8640000000001, 1731700000000000, '1731700000000000', 1e300].forEach((v) => {
        const got = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', updated_at: v });
        check(`S9 updated_at ${show(v)} is dropped, the row kept`, !!got && !('updated_at' in got) && got.alias === 'A', show(got));
    });
    check('S9 isoOfEpoch formats a valid epoch, a string of one and the latest one', ha.isoOfEpoch(1731700000) === '2024-11-15T19:46:40.000Z'
        && ha.isoOfEpoch('1700000000') === '2023-11-14T22:13:20.000Z' && ha.isoOfEpoch(8.64e12) === '+275760-09-13T00:00:00.000Z',
        show([ha.isoOfEpoch(1731700000), ha.isoOfEpoch('1700000000'), ha.isoOfEpoch(8.64e12)]));
    const NO_EPOCH: unknown[] = [undefined, null, 0, -1, NaN, Infinity, -Infinity, 8640000000001, 1731700000000000, '', '  ', 'x',
        {}, [1], '1e300', true];
    const isoThrows: string[] = [];
    const isoNotNull: string[] = [];
    NO_EPOCH.forEach((v) => {
        try {
            if (ha.isoOfEpoch(v) !== null) {
                isoNotNull.push(show(v));
            }
        } catch (e) {
            isoThrows.push(show(v));
        }
    });
    check('S9 isoOfEpoch is null for no time, never throws', isoThrows.length === 0 && isoNotNull.length === 0,
        `threw: ${isoThrows.join(', ')}; not null: ${isoNotNull.join(', ')}`);
    // Every value sanitizeAliasRow keeps formats: the editor's cell title calls isoOfEpoch on it.
    const keptButUnformatted = [1, 1731700000, 8.64e12, '42', 0.5].filter((v) => {
        const kept = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'A', updated_at: v });
        return !kept || typeof kept.updated_at !== 'number' || ha.isoOfEpoch(kept.updated_at) === null;
    });
    check('S9 every updated_at a row keeps formats with isoOfEpoch', keptButUnformatted.length === 0, show(keptButUnformatted));

    // S10 the characters read by code point (SEC-3): every format character (general category Cf) is refused inside
    // a word, and no default-ignorable code point shows on its own, whatever its plane.
    // The constructor, not a literal: a property escape in a literal needs a later compile target than the package's.
    // eslint-disable-next-line prefer-regex-literals
    const cfRe = new RegExp('^\\p{Cf}$', 'u');
    // eslint-disable-next-line prefer-regex-literals
    const diRe = new RegExp('^\\p{Default_Ignorable_Code_Point}$', 'u');
    const cfPassed: string[] = [];
    const diShown: string[] = [];
    let cfCount = 0;
    let diCount = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
        // The surrogates are no characters of their own.
        const c = cp >= 0xd800 && cp <= 0xdfff ? '' : String.fromCodePoint(cp);
        if (c !== '' && cfRe.test(c)) {
            cfCount += 1;
            if (!ha.hasForbiddenChars(`a${c}b`) && cfPassed.length < 20) {
                cfPassed.push(`U+${cp.toString(16)}`);
            }
        }
        if (c !== '' && diRe.test(c)) {
            diCount += 1;
            if (ha.hasVisibleChar(c) && diShown.length < 20) {
                diShown.push(`U+${cp.toString(16)}`);
            }
        }
    }
    check('S10 every format character (Cf) is refused inside a word', cfCount > 150 && cfPassed.length === 0,
        `${cfCount} Cf code points; passed: ${cfPassed.join(', ')}`);
    check('S10 no default-ignorable code point shows on its own', diCount > 4000 && diShown.length === 0,
        `${diCount} default-ignorable code points; shown: ${diShown.join(', ')}`);
    const SUPP_CODES = [0x180b, 0x180c, 0x180d, 0x180e, 0x180f, 0x17b4, 0x17b5, 0xe0000, 0xe0001, 0xe0020, 0xe0041, 0xe007f,
        0xe0100, 0xe01ef, 0xe0fff, 0xfff0, 0xfff9, 0xfffa, 0xfffb, 0x1d173, 0x1d17a, 0x1bca0, 0x1bca3, 0x0600, 0x0605, 0x06dd,
        0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd, 0x13430, 0x1343f];
    SUPP_CODES.forEach((cp) => {
        const c = String.fromCodePoint(cp);
        const u = `U+${cp.toString(16)}`;
        check(`S10 ${u} is refused in an alias, a description and a match value`,
            ha.sanitizeAliasRow({ match_value: 'app01', alias: `Pay${c}roll` }) === null
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: 'Payroll', description: `x${c}y` }) === null
            && ha.sanitizeAliasRow({ match_value: `app${c}01`, alias: 'A' }) === null
            && ha.hasForbiddenChars(c) && ha.hasForbiddenChars(`${c}ab`) && ha.hasForbiddenChars(`ab${c}`), 'must refuse');
    });
    const tagged = `Pay${String.fromCodePoint(0xe0020)}roll`;
    const tagCsv = ha.parseAliasCsv(`host,alias\napp01,${tagged}\n`);
    check('S10 "Pay" + U+E0020 + "roll" is refused on read and on import, with the invisible-character message',
        ha.sanitizeAliasRow({ match_value: 'app01', alias: tagged }) === null && tagCsv.rows.length === 0
        && same(tagCsv.errors, [{ line: 2, message: 'alias holds a control character, a line break, a direction mark or an'
            + ' invisible character' }]), show(tagCsv));
    const tagsOnly = [0xe0041, 0xe0042, 0xe007f].map((cp) => String.fromCodePoint(cp)).join('');
    check('S10 an alias of tag characters alone is refused', ha.sanitizeAliasRow({ match_value: 'app01', alias: tagsOnly }) === null
        && !ha.hasVisibleChar(tagsOnly), show(tagsOnly));
    const VISIBLE_ASTRAL = [String.fromCodePoint(0x1f600), String.fromCodePoint(0x20000), `A${ch(0xfe0f)}`,
        `${ch(0x0627)}${ch(0x0644)}${ch(0x062f)}`];
    VISIBLE_ASTRAL.forEach((s) => {
        check(`S10 ${show(s)} shows and is kept`, ha.hasVisibleChar(s) && !ha.hasForbiddenChars(s)
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: s }) !== null, 'must accept');
    });
    check('S10 a variation selector alone is refused, after a letter kept', ha.sanitizeAliasRow({ match_value: 'app01', alias: ch(0xfe0f) })
        === null && ha.sanitizeAliasRow({ match_value: 'app01', alias: `A${ch(0xfe0f)}` }) !== null, '');
    // N6 (owner decision): isForbiddenCode refuses these anywhere in a name, after a character that shows too; the
    // entries isBlankAlone keeps for them are reached only if that refusal is ever eased, and its comments say so.
    check('S10 the supplement of variation selectors (U+E0100-U+E01EF) and the Mongolian ones are refused anywhere'
        + ' (isForbiddenCode, owner decision), alone and after a letter',
    [0xe0100, 0xe01ef, 0x180b, 0x180c, 0x180d, 0x180f].every((cp) => {
        const c = String.fromCodePoint(cp);
        return !ha.hasVisibleChar(c) && ha.hasForbiddenChars(c) && ha.hasForbiddenChars(`A${c}`)
            && ha.sanitizeAliasRow({ match_value: 'app01', alias: `${ch(0x845b)}${c}` }) === null;
    }), '');
    const eased = read(path.join(HOME, 'utils/hostAlias.ts')).replace(/\s*\n\s*(\*|\/\/)\s*/g, ' ');
    check('S10 hostAlias.ts says the isBlankAlone entries of those selectors are reached only if isForbiddenCode is eased',
        (eased.match(/reached only if isForbiddenCode is ever eased/g) || []).length >= 3
        && /except the grapheme joiner U\+034F and the variation selectors U\+FE00-U\+FE0F/.test(eased)
        && !/except the marks isBlankAlone lists/.test(eased), 'the isForbiddenCode and isBlankAlone comments');
    const lone = ch(0xd83d);
    check('S10 a lone surrogate is read as itself: it shows and is not forbidden', ha.hasVisibleChar(lone) && !ha.hasForbiddenChars(lone)
        && !ha.hasForbiddenChars(`a${lone}b`) && ha.hasVisibleChar(`${ch(0xde00)}`), '');
    // A lone high surrogate takes the next unit only when that unit is a low surrogate: it never hides the character
    // after it (U+200B and U+202E are no low surrogates).
    check('S10 a lone high surrogate followed by a forbidden character is refused (it does not swallow it)',
        ha.hasForbiddenChars(`x${lone}${ch(0x200b)}y`) && ha.hasForbiddenChars(`${lone}${ch(0x202e)}`)
        && ha.hasForbiddenChars(`x${ch(0xdbff)}${ch(0x200b)}`)
        && ha.sanitizeAliasRow({ match_value: 'app01', alias: `Pay${lone}${ch(0x200b)}roll` }) === null, '');
    check('S10 a character after an astral one is still read (the walk steps by code point)',
        ha.hasForbiddenChars(`${String.fromCodePoint(0x1f600)}${ch(0x200b)}`)
        && ha.hasForbiddenChars(`${String.fromCodePoint(0x20000)}${String.fromCodePoint(0xe0020)}x`)
        && ha.hasVisibleChar(`${String.fromCodePoint(0xe0020)}${String.fromCodePoint(0x1f600)}`), '');
}

/* ---- C CSV import ---- */
const keysOf = (res: { rows: Array<{ _key: string }> }): string[] => res.rows.map((x) => x._key);
const linesOf = (res: { errors: Array<{ line: number }> }): number[] => res.errors.map((e) => e.line);
{
    const c1 = ha.parseAliasCsv('host,alias,description\r\napp01,Billing App,Front end\r\n');
    check('C1 a plain file', same(c1.rows, [{ _key: 'app01', match_value: 'app01', alias: 'Billing App', description: 'Front end' }])
        && c1.errors.length === 0 && c1.warnings.length === 0, show(c1));
    const c2 = ha.parseAliasCsv(`${ch(0xfeff)}host,alias\napp01,X\n`);
    check('C2 a byte order mark', same(keysOf(c2), ['app01']) && c2.errors.length === 0, show(c2));
    const c2b = ha.parseAliasCsv(`${ch(0xfeff)}"host","alias"\r\n"app01","X"\r\n`);
    check('C2 a byte order mark before a quoted header', same(keysOf(c2b), ['app01']) && c2b.errors.length === 0, show(c2b));
    const c3 = ha.parseAliasCsv('Alias,DESCRIPTION, Host \nX,the d,App01.Example.com\n');
    check('C3 header in another order and case', same(c3.rows, [{ _key: 'app01.example.com', match_value: 'App01.Example.com',
        alias: 'X', description: 'the d' }]), show(c3));
    const c4 = ha.parseAliasCsv('host,alias\napp01,X');
    check('C4 no description column, no final line break', same(c4.rows, [{ _key: 'app01', match_value: 'app01', alias: 'X' }]),
        show(c4));
    const c5 = ha.parseAliasCsv('host,alias\n"app02","Billing, ""North"""\n');
    check('C5 quotes, doubled quotes and a comma inside', c5.rows.length === 1 && c5.rows[0].alias === 'Billing, "North"', show(c5));
    const c6 = ha.parseAliasCsv('host,alias,description\napp03,X,"line1\nline2"\napp04,Y,ok\napp05,\n');
    check('C6 a line break inside quotes stays in its field (and is refused there); later lines keep their numbers',
        same(keysOf(c6), ['app04']) && same(linesOf(c6), [2, 5]) && /line break/.test(c6.errors[0].message), show(c6));
    const c6b = ha.parseAliasCsv('host,alias,description\r\napp03,X,"a\r\nb"\r\napp05,Z,"x,y"\r\n');
    check('C6 the same with CRLF, and a comma inside quotes', same(keysOf(c6b), ['app05']) && same(linesOf(c6b), [2])
        && c6b.rows[0].description === 'x,y', show(c6b));
    const c7 = ha.parseAliasCsv('\r\nhost,alias\r\n\r\napp05,X\r\n\n  \n,,\napp06,Y\rapp07,Z');
    check('C7 CRLF, LF, a lone CR and blank lines', same(keysOf(c7), ['app05', 'app06', 'app07']) && c7.errors.length === 0, show(c7));
    const c8 = ha.parseAliasCsv('app01,X\napp02,Y\n');
    check('C8 no header: nothing imported', c8.rows.length === 0 && same(linesOf(c8), [1]), show(c8));
    const c8b = ha.parseAliasCsv('host,name\napp01,X\n');
    check('C8 a header without alias', c8b.rows.length === 0 && c8b.errors.length === 1, show(c8b));
    const c8c = ha.parseAliasCsv('');
    check('C8 an empty file', c8c.rows.length === 0 && c8c.errors.length === 1
        && ha.parseAliasCsv(ch(0xfeff)).errors.length === 1, show(c8c));
    const c9 = ha.parseAliasCsv('host,alias,owner,env\napp01,X,someone,prd\n');
    check('C9 unknown columns ignored, one warning', same(keysOf(c9), ['app01']) && c9.errors.length === 0
        && c9.warnings.length === 1 && /owner/.test(c9.warnings[0].message) && /env/.test(c9.warnings[0].message), show(c9));
    const c9b = ha.parseAliasCsv('host,alias,host\napp01,X,app02\n');
    check('C9 a column named twice: nothing imported, the column named, no hint (the header is valid CSV with commas)',
        c9b.rows.length === 0 && same(c9b.errors, [{ line: 1, message: 'The header names a column twice: host' }]), show(c9b));
    const c10 = ha.parseAliasCsv('host,alias\napp07,X\nAPP07.,X\n');
    check('C10 an exact repeat (same key, same alias): a warning on the later line, which is skipped; no error',
        same(keysOf(c10), ['app07']) && c10.errors.length === 0 && same(c10.warnings.map((w: any) => w.line), [3])
        && /already on line 2 with the same alias; this line is skipped/.test(c10.warnings[0].message), show(c10));
    const c11 = ha.parseAliasCsv('host,alias\napp08,X\napp09,Z\nApp08,Y\napp08,X\n');
    check('C11 two aliases for one host: every line of it refused', same(keysOf(c11), ['app09'])
        && same(linesOf(c11), [2, 4, 5]), show(c11));
    const c12 = ha.parseAliasCsv('host,alias\n192.0.2.10,A\n::ffff:192.0.2.10,A\n');
    check('C12 two forms of one IP are one key (the second an exact repeat)', same(keysOf(c12), ['192.0.2.10'])
        && c12.errors.length === 0 && same(c12.warnings.map((w: any) => w.line), [3]), show(c12));
    const c13 = ha.parseAliasCsv([
        'host,alias,description',
        ',X',
        'app10,',
        'app 10,X',
        'app10:80,X',
        `app11,${repeat('a', 65)}`,
        'app12,<b>',
        `app13,X,${repeat('d', 257)}`,
        '"app14"x,X',
        'app15,X,d,extra',
        'app16,X,d,',
        '"app17,X',
    ].join('\n'));
    check('C13 one error per bad line, the good line imported', same(keysOf(c13), ['app16'])
        && same(linesOf(c13), [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]), show(c13));
    check('C13 the messages', /host is empty/.test(c13.errors[0].message) && /alias is empty/.test(c13.errors[1].message)
        && /not a host name/.test(c13.errors[2].message) && /not a host name/.test(c13.errors[3].message)
        && /longer than 64/.test(c13.errors[4].message) && /< or >/.test(c13.errors[5].message)
        && /longer than 256/.test(c13.errors[6].message) && /closing quote/.test(c13.errors[7].message)
        && /more fields/.test(c13.errors[8].message) && /not closed/.test(c13.errors[9].message), show(c13.errors));
    const big = (n: number): string => {
        const lines = ['host,alias'];
        for (let i = 0; i < n; i += 1) {
            lines.push(`h${i}.example.com,Host ${i}`);
        }
        return lines.join('\n');
    };
    const atMax = ha.parseAliasCsv(big(5000));
    check('C14 5000 rows import', atMax.rows.length === 5000 && atMax.errors.length === 0, `${atMax.rows.length} rows`);
    const overMax = ha.parseAliasCsv(big(5001));
    check('C14 5001 rows: nothing imported, one error', overMax.rows.length === 0 && overMax.errors.length === 1
        && /5001/.test(overMax.errors[0].message), show(overMax.errors));
    const guarded = ha.parseAliasCsv('host,alias,description\napp01,\'=1+1,\'-old\n');
    check('C15 the formula guard is removed on import', guarded.rows.length === 1 && guarded.rows[0].alias === '=1+1'
        && guarded.rows[0].description === '-old', show(guarded));
    const c16 = ha.parseAliasCsv([
        'host,alias,description',
        `app18,Pay${ch(0x200b)}roll`,
        `app19,${ch(0x3164)}`,
        `app20,${ch(0x2800)}`,
        `app21,X,a${ch(0xad)}b`,
        `app22,Pay${ch(0xfeff)}roll`,
        'app23,Payroll',
    ].join('\n'));
    check('C16 invisible characters and an alias with nothing that shows are refused, line by line',
        same(keysOf(c16), ['app23']) && same(linesOf(c16), [2, 3, 4, 5, 6]), show(c16));
    check('C16 the messages', c16.errors.length === 5 && /invisible character/.test(c16.errors[0].message)
        && /^alias /.test(c16.errors[0].message) && /invisible character/.test(c16.errors[1].message)
        && /no character that shows/.test(c16.errors[2].message) && /^description .*invisible character/.test(c16.errors[3].message)
        && /invisible character/.test(c16.errors[4].message), show(c16.errors));

    // C17 repeats: an exact repeat (the same alias, letter case counting, and the same description or none on one
    // of the two lines, in either order) is a warning and skipped, and the accepted row keeps the non-empty
    // description; two different aliases or two different non-empty descriptions refuse every line of the host.
    const warnLines = (res: { warnings: Array<{ line: number }> }): number[] => res.warnings.map((w) => w.line);
    const c17a = ha.parseAliasCsv('host,alias,description\napp30,X,d\nAPP30.,X,\napp30,X, d \napp31,Y,\n');
    check('C17 exact repeats: the first line imported with its description, the repeats warned and skipped',
        same(c17a.rows, [{ _key: 'app30', match_value: 'app30', alias: 'X', description: 'd' },
            { _key: 'app31', match_value: 'app31', alias: 'Y' }]) && c17a.errors.length === 0
        && same(warnLines(c17a), [3, 4]) && c17a.warnings.every((w: any) => /line 2 .*skipped/.test(w.message)), show(c17a));
    const c17b = ha.parseAliasCsv('host,alias,description\napp32,X,first\napp32,X,second\napp33,Z,\n');
    check('C17 two different non-empty descriptions: both lines refused, the host not imported', same(keysOf(c17b), ['app33'])
        && same(linesOf(c17b), [2, 3])
        && c17b.errors.every((e: any) => /another description on line [23]; none of its lines/.test(e.message))
        && c17b.warnings.length === 0, show(c17b));
    const c17c = ha.parseAliasCsv('host,alias,description\napp34,X,\napp34,X,later\n');
    check('C17 an empty description first and a non-empty one later is an exact repeat: the later line warned and'
        + ' skipped, its description kept', same(c17c.rows, [{ _key: 'app34', match_value: 'app34', alias: 'X', description: 'later' }])
        && c17c.errors.length === 0 && same(warnLines(c17c), [3])
        && /^this host is already on line 2 with the same alias and no description; this line is skipped and its description used$/
            .test(c17c.warnings[0].message), show(c17c));
    const c17f = ha.parseAliasCsv('host,alias,description\napp37,X,kept\nAPP37.,X,\n');
    check('C17 a non-empty description first and an empty one later: the first line imported, the later one warned and'
        + ' skipped', same(c17f.rows, [{ _key: 'app37', match_value: 'app37', alias: 'X', description: 'kept' }])
        && c17f.errors.length === 0 && same(warnLines(c17f), [3])
        && /^this host is already on line 2 with the same alias; this line is skipped$/.test(c17f.warnings[0].message), show(c17f));
    const fwd = ha.parseAliasCsv('host,alias,description\napp44,X,d\napp44,X,\n');
    const bwd = ha.parseAliasCsv('host,alias,description\napp44,X,\napp44,X,d\n');
    check('C17 the order of an empty and a non-empty description does not matter', same(fwd.rows, bwd.rows)
        && same(fwd.rows, [{ _key: 'app44', match_value: 'app44', alias: 'X', description: 'd' }])
        && fwd.errors.length === 0 && bwd.errors.length === 0 && same(warnLines(fwd), [3]) && same(warnLines(bwd), [3]),
        show([fwd, bwd]));
    const c17g = ha.parseAliasCsv('host,alias,description\napp38,X,\nAPP38.,X,\napp38,X,d\napp38,X,\napp38,X, d \n');
    check('C17 three lines and more: empty, empty, then a description, then empty and the same: one row with the'
        + ' description, every later line warned', same(c17g.rows, [{ _key: 'app38', match_value: 'app38', alias: 'X', description: 'd' }])
        && c17g.errors.length === 0 && same(warnLines(c17g), [3, 4, 5, 6])
        && /and no description; this line is skipped and its description used$/.test(c17g.warnings[1].message)
        && /with the same alias; this line is skipped$/.test(c17g.warnings[2].message), show(c17g));
    const c17h = ha.parseAliasCsv('host,alias,description\napp39,X,\napp39,X,first\napp39,X,second\napp39,X,\napp42,Z,\n');
    check('C17 empty, then two different descriptions: every line of the host refused, the line that gave the first'
        + ' description too (its warning dropped), the messages naming the two lines that differ',
        same(keysOf(c17h), ['app42']) && same(linesOf(c17h), [2, 3, 4, 5]) && c17h.warnings.length === 0
        && /^this host has another description on line 4; none of its lines is imported$/.test(c17h.errors[0].message)
        && /^this host has another description on line 4; none of its lines is imported$/.test(c17h.errors[1].message)
        && /^this host has another description on line 3; none of its lines is imported$/.test(c17h.errors[2].message)
        && /on lines 3 and 4 with different descriptions/.test(c17h.errors[3].message), show(c17h));
    const c17i = ha.parseAliasCsv('host,alias,description\napp43,Payroll,d\napp43,payroll,d\n');
    check('C17 two aliases that differ only in letter case are two aliases: both lines refused', keysOf(c17i).length === 0
        && same(linesOf(c17i), [2, 3]) && /another alias on line 3/.test(c17i.errors[0].message)
        && /another alias on line 2/.test(c17i.errors[1].message) && c17i.warnings.length === 0, show(c17i));
    const c17d = ha.parseAliasCsv('host,alias\napp35,X\napp35,Y\napp35,X\n');
    check('C17 a later line of a refused host names both lines and what differs', keysOf(c17d).length === 0
        && same(linesOf(c17d), [2, 3, 4]) && /on lines 2 and 3 with different aliases/.test(c17d.errors[2].message)
        && /another alias on line 3/.test(c17d.errors[0].message) && c17d.warnings.length === 0, show(c17d));
    // A repeat skipped before a later line that conflicts is refused with the host's other lines and loses its
    // warning (so the fill text "this line is skipped and its description used" never shows for a refused host).
    // Each file ends with another host, app49, which imports.
    const refusedAll = (res: any, lines: number[], what: 'alias' | 'description'): boolean => {
        const other = new RegExp(`^this host has another ${what} on line \\d+; none of its lines is imported$`);
        const both = new RegExp(`^this host is on lines \\d+ and \\d+ with different ${what === 'alias' ? 'aliases' : 'descriptions'}`
            + '; none of its lines is imported$');
        return same(linesOf(res), lines) && res.warnings.length === 0 && same(keysOf(res), ['app49'])
            && res.errors.every((e: any) => other.test(e.message) || both.test(e.message));
    };
    const c17e = ha.parseAliasCsv('host,alias,description\napp36,X,a\napp36,X,\napp36,X,b\napp49,Z,\n');
    check('C17 d,E,e: a repeat skipped, then a different description: lines 2, 3 and 4 refused, no warning',
        refusedAll(c17e, [2, 3, 4], 'description')
        && /^this host has another description on line 4; none/.test(c17e.errors[0].message)
        && /^this host has another description on line 4; none/.test(c17e.errors[1].message)
        && /^this host has another description on line 2; none/.test(c17e.errors[2].message), show(c17e));
    const c17j = ha.parseAliasCsv('host,alias,description\napp45,X,\napp45,X,d\napp45,Y,\napp49,Z,\n');
    check('C17 E,d,Y: the line that filled the description is refused with the rest, no "description used" warning',
        refusedAll(c17j, [2, 3, 4], 'alias')
        && /^this host has another alias on line 4; none/.test(c17j.errors[1].message)
        && /^this host has another alias on line 2; none/.test(c17j.errors[2].message)
        && JSON.stringify(c17j).indexOf('description used') === -1, show(c17j));
    const c17k = ha.parseAliasCsv('host,alias,description\napp46,X,\napp46,X,\napp46,Y,\napp49,Z,\n');
    check('C17 E,E,Y: a plain repeat, then another alias: lines 2, 3 and 4 refused, no warning',
        refusedAll(c17k, [2, 3, 4], 'alias') && /^this host has another alias on line 4; none/.test(c17k.errors[1].message),
        show(c17k));
    const c17l = ha.parseAliasCsv('host,alias,description\napp47,X,\napp47,X,\napp47,X,d\napp47,X,e\napp49,Z,\n');
    check('C17 E,E,d,e: every skipped repeat refused, the line that gave the description too: lines 2 to 5, no warning',
        refusedAll(c17l, [2, 3, 4, 5], 'description')
        && c17l.errors.slice(0, 3).every((e: any) => /^this host has another description on line 5; none/.test(e.message))
        && /^this host has another description on line 4; none/.test(c17l.errors[3].message), show(c17l));
    const c17m = ha.parseAliasCsv('host,alias,description\napp48,X,\napp48,X,d\napp48,X,\napp48,X,e\napp49,Z,\n');
    check('C17 E,d,E,e: a repeat after the fill is refused too: lines 2 to 5, no warning',
        refusedAll(c17m, [2, 3, 4, 5], 'description')
        && c17m.errors.slice(0, 3).every((e: any) => /^this host has another description on line 5; none/.test(e.message))
        && /^this host has another description on line 3; none/.test(c17m.errors[3].message), show(c17m));

    // C18 U+FFFD: the character a UTF-8 decoder writes for bytes it could not read (a file saved as cp1252).
    const fffd = ch(0xfffd);
    const c18 = ha.parseAliasCsv([
        'host,alias,description,owner',
        `app40,Z${fffd}rich DB`,
        'app41,Fine',
        `app42,X,d${fffd}`,
        `app43,X,,J${fffd}rg`,
        `app4${fffd},X`,
    ].join('\n'));
    check('C18 any cell holding U+FFFD refuses its line (alias, description, an ignored column, the host)',
        same(keysOf(c18), ['app41']) && same(linesOf(c18), [2, 4, 5, 6]), show(c18));
    check('C18 the message says what to do', c18.errors.every((e: any) => e.message.indexOf(ha.UNREADABLE_LINE_TEXT) === 0)
        && ha.UNREADABLE_LINE_TEXT === 'this line holds a character that could not be read; save the file as CSV UTF-8 '
        + '(in Excel: Save As > CSV UTF-8 (Comma delimited))', show(c18.errors));
    check('C18 without the rule such an alias would pass (sanitizeAliasRow keeps U+FFFD)',
        ha.sanitizeAliasRow({ match_value: 'app40', alias: `Z${fffd}rich DB` }) !== null, 'the rule is the only guard');

    // C19 a header with semicolons or tabs and no comma: the header error says to use commas.
    const c19a = ha.parseAliasCsv('host;alias;description\napp01;X;\n');
    const c19b = ha.parseAliasCsv(`host${ch(9)}alias\napp01${ch(9)}X\n`);
    const c19c = ha.parseAliasCsv('host,name\napp01,X\n');
    const c19d = ha.parseAliasCsv('"host;alias"\napp01\n');
    const hinted = (res: any): boolean => res.rows.length === 0 && res.errors.length === 1 && res.errors[0].line === 1
        && res.errors[0].message
            === `The first line must be the header host,alias,description (description is optional); ${ha.SEPARATOR_HINT_TEXT}`;
    check('C19 semicolons: the header error adds the separator hint', hinted(c19a), show(c19a));
    check('C19 tabs: the header error adds the separator hint', hinted(c19b), show(c19b));
    check('C19 a comma header without alias: no separator hint', c19c.errors.length === 1
        && c19c.errors[0].message.indexOf(ha.SEPARATOR_HINT_TEXT) === -1, show(c19c));
    check('C19 a quoted single header with a semicolon is a semicolon header too', hinted(c19d), show(c19d));
    const c19e = ha.parseAliasCsv('"host,alias;x"\napp01\n');
    check('C19 a header that holds a comma (quoted) gets no separator hint', c19e.errors.length === 1
        && c19e.errors[0].message.indexOf(ha.SEPARATOR_HINT_TEXT) === -1, show(c19e));
    check('C19 the hint text', ha.SEPARATOR_HINT_TEXT === 'separate the columns with commas, not semicolons or tabs',
        ha.SEPARATOR_HINT_TEXT);
    // A quoted header in another separator is not valid CSV (text after a closing quote); its line as written gets the
    // hint when it has a semicolon or a tab and no comma outside quotes.
    const quotedHinted = (res: any): boolean => res.rows.length === 0 && res.errors.length === 1 && res.errors[0].line === 1
        && res.errors[0].message === `The header line is not valid CSV: text follows a closing quote; ${ha.SEPARATOR_HINT_TEXT}`;
    const c19f = ha.parseAliasCsv('"host";"alias";"description"\r\n"app01";"X";""\r\n');
    check('C19 a quoted semicolon header (PowerShell Export-Csv -Delimiter \';\') gets the separator hint', quotedHinted(c19f),
        show(c19f));
    const c19g = ha.parseAliasCsv(`"host"${ch(9)}"alias"\n"app01"${ch(9)}"X"\n`);
    check('C19 a quoted tab header gets the separator hint', quotedHinted(c19g), show(c19g));
    const c19i = ha.parseAliasCsv('"host,x";"alias"\napp01;X\n');
    check('C19 a comma inside quotes is no comma: the quoted semicolon header still gets the hint', quotedHinted(c19i), show(c19i));
    const c19h = ha.parseAliasCsv('"host";"alias","description"\napp01,X,\n');
    check('C19 a header not valid CSV with a comma outside quotes gets no separator hint', c19h.errors.length === 1
        && c19h.errors[0].message === 'The header line is not valid CSV: text follows a closing quote', show(c19h));
    // A header holding U+FFFD or a NUL (a file in a legacy code page, or BOM-less UTF-16, read as UTF-8): the header
    // error says to save the file as CSV UTF-8, in place of the separator hint. A UTF-16 file WITH a byte order mark
    // (Excel's "Unicode Text") is decoded correctly by FileReader, so it never reaches parseAliasCsv as NULs.
    const nul = ch(0);
    const asBomlessUtf16 = (t: string): string => t.split('').map((c) => `${c}${nul}`).join('');
    const encHinted = (res: any, start: string): boolean => res.rows.length === 0 && res.errors.length === 1
        && res.errors[0].line === 1 && res.errors[0].message === `${start}; ${ha.HEADER_UNREADABLE_TEXT}`;
    const MISSING_HEADER = 'The first line must be the header host,alias,description (description is optional)';
    const c19j = ha.parseAliasCsv(asBomlessUtf16(`host${ch(9)}alias\r\napp01${ch(9)}X\r\n`));
    check('C19 a BOM-less UTF-16 tab file read as UTF-8: save as CSV UTF-8, not the separator hint',
        encHinted(c19j, MISSING_HEADER), show(c19j));
    const c19p = ha.parseAliasCsv(`J${fffd}rg${ch(9)}alias\r\napp01${ch(9)}X\r\n`);
    check('C19 a tab header from a legacy code page (U+FFFD, no NUL): save as CSV UTF-8, not the separator hint',
        encHinted(c19p, MISSING_HEADER), show(c19p));
    const c19k = ha.parseAliasCsv(`h${nul}o${nul}s${nul}t${nul},${nul}a${nul}l${nul}i${nul}a${nul}s${nul}\napp01,X\n`);
    check('C19 a NUL in the header alone (no U+FFFD) gives the same text', encHinted(c19k, MISSING_HEADER), show(c19k));
    const c19l = ha.parseAliasCsv(`"h${fffd}st";"alias"\napp01;X\n`);
    check('C19 a header not valid CSV holding U+FFFD: save as CSV UTF-8', encHinted(c19l,
        'The header line is not valid CSV: text follows a closing quote'), show(c19l));
    const c19m = ha.parseAliasCsv(`host,alias,J${fffd}rg,J${fffd}rg\napp01,X,,\n`);
    check('C19 a header naming a column twice, holding U+FFFD: save as CSV UTF-8', encHinted(c19m,
        `The header names a column twice: j${fffd}rg`), show(c19m));
    const c19o = ha.parseAliasCsv(`host;alias\napp01;Z${fffd}rich\n`);
    check('C19 U+FFFD on a later line only: the header error keeps the separator hint (only the header line is read)',
        hinted(c19o), show(c19o));
    const c19n = ha.parseAliasCsv(`host,alias,Beschr${fffd}ibung\napp01,X,\n`);
    check('C19 a header that names host and alias imports, U+FFFD in another column name or not', c19n.errors.length === 0
        && same(keysOf(c19n), ['app01']) && c19n.warnings.length === 1, show(c19n));
    check('C19 the header text', ha.HEADER_UNREADABLE_TEXT === 'the header holds a character that could not be read; save'
        + ' the file as CSV UTF-8 (in Excel: Save As > CSV UTF-8 (Comma delimited))', ha.HEADER_UNREADABLE_TEXT);
}

/* ---- X CSV export and the round trip ---- */
{
    check('X1 the header alone', ha.toAliasCsv([]) === 'host,alias,description\r\n', show(ha.toAliasCsv([])));
    const rows = [
        { _key: 'h2', match_value: 'h2', alias: 'b' },
        { _key: 'h3', match_value: 'h3', alias: 'A' },
        { _key: 'h1', match_value: 'h1', alias: 'a' },
        { _key: 'h0', match_value: 'H0', alias: 'a' },
    ];
    const out = ha.toAliasCsv(rows);
    check('X2 sorted by alias, then host; CRLF', out === 'host,alias,description\r\nh3,A,\r\nH0,a,\r\nh1,a,\r\nh2,b,\r\n', show(out));
    const reversed = rows.slice().reverse();
    check('X2 the order does not depend on the input order', ha.toAliasCsv(reversed) === out, '');
    const g = ha.toAliasCsv([
        { _key: 'a1', match_value: 'a1', alias: '=SUM(A1)', description: '+1' },
        { _key: 'a2', match_value: 'a2', alias: '-old', description: '@home' },
    ]);
    check('X3 formula cells get a leading single quote',
        g === 'host,alias,description\r\na2,\'-old,\'@home\r\na1,\'=SUM(A1),\'+1\r\n', show(g));
    const q = ha.toAliasCsv([{ _key: 'a1', match_value: 'a1', alias: 'Billing, "North"', description: 'x' }]);
    check('X4 RFC 4180 quoting', q === 'host,alias,description\r\na1,"Billing, ""North""",x\r\n', show(q));
    // toAliasCsv takes any HostAliasRow, not only sanitized ones (which never hold a tab, a CR or an outer space).
    const tab = ch(9);
    const lead = ha.toAliasCsv([
        { _key: 't1', match_value: 't1', alias: `${tab}x`, description: ' lead' },
        { _key: 't2', match_value: 't2', alias: `${ch(13)}y`, description: 'trail ' },
    ]);
    check('X6 a cell led by a tab or a CR is guarded; a cell with an outer space is quoted',
        lead === `host,alias,description\r\nt1,'${tab}x," lead"\r\nt2,"'${ch(13)}y","trail "\r\n`, show(lead));
    const trip = [
        { _key: 'app01.example.com', match_value: 'App01.Example.com', alias: 'Billing App', description: 'Front, end' },
        { _key: '192.0.2.10', match_value: '192.0.2.10', alias: 'Billing App' },
        { _key: '2001:db8::1', match_value: '2001:DB8::1', alias: '"Quoted"' },
        { _key: 'old01', match_value: 'old01', alias: '-old', description: '=not a formula' },
        { _key: 'q01', match_value: 'q01', alias: '\'=x', description: '\'plain' },
        { _key: 'q02', match_value: 'q02', alias: '\'\'+y' },
        { _key: 'u01', match_value: 'u01', alias: `Fakturierung ${ch(0xe4)}` },
    ];
    const back = ha.parseAliasCsv(ha.toAliasCsv(trip));
    const byKey = (list: Array<{ _key: string }>): Array<{ _key: string }> =>
        list.slice().sort((x, y) => (x._key < y._key ? -1 : 1));
    check('X5 parseAliasCsv(toAliasCsv(rows)) gives the rows back', back.errors.length === 0
        && same(byKey(back.rows), byKey(trip)), `${show(back.errors)} ${show(byKey(back.rows))}`);
    // Export writes a byte order mark in front (KV-9, so Excel opens the file as UTF-8): import drops it.
    const backBom = ha.parseAliasCsv(`${ch(0xfeff)}${ha.toAliasCsv(trip)}`);
    check('X7 the export with its byte order mark imports back the same rows', backBom.errors.length === 0
        && backBom.warnings.length === 0 && same(byKey(backBom.rows), byKey(trip)), show(backBom.errors));
    // Export's empty template (KV-12): the header alone parses to no rows and no error, which the preview names.
    const template = ha.parseAliasCsv(`${ch(0xfeff)}${ha.toAliasCsv([])}`);
    check('X8 Export\'s empty template parses to no rows, no error and no warning', template.rows.length === 0
        && template.errors.length === 0 && template.warnings.length === 0, show(template));
}

/* ---- D display names ---- */
{
    const map: { [raw: string]: string } = {
        'app01.example.com': 'Billing App',
        '192.0.2.10': 'Billing App',
        'app01.example.net': 'B',
        'app01.example.org': 'B',
        app02: 'Payroll',
        x: 'y',
        z: 'Z',
    };
    const res = (raw: string): string | null => (Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : null);
    const none = ha.aliasDisplayNames(['a', 'b'], () => null);
    check('D1 no alias: the raw values', same(none, ['a', 'b']), show(none));
    check('D2 one alias', same(ha.aliasDisplayNames(['z', 'a'], res), ['Z', 'a']), '');
    const d3 = ha.aliasDisplayNames(['app01.example.com', '192.0.2.10', 'other'], res);
    check('D3 two raw values with one alias: alias (short form)',
        same(d3, ['Billing App (app01)', 'Billing App (192.0.2.10)', 'other']), show(d3));
    check('D4 short forms collide too: alias (raw value)', same(ha.aliasDisplayNames(['app01.example.net', 'app01.example.org'], res),
        ['B (app01.example.net)', 'B (app01.example.org)']), show(ha.aliasDisplayNames(['app01.example.net', 'app01.example.org'], res)));
    check('D5 an alias equal to an unaliased raw value', same(ha.aliasDisplayNames(['Payroll', 'app02'], res), ['Payroll', 'Payroll (app02)']),
        show(ha.aliasDisplayNames(['Payroll', 'app02'], res)));
    check('D6 every step collides: that value shows raw, the others keep their names',
        same(ha.aliasDisplayNames(['x', 'y (x)', 'y', 'z'], res), ['x', 'y (x)', 'y', 'Z']),
        show(ha.aliasDisplayNames(['x', 'y (x)', 'y', 'z'], res)));
    // Distinct raw values always give distinct names, and an unaliased value always keeps its raw value
    // (a deterministic pseudo-random sweep over values that collide on purpose).
    const POOL = ['a', 'a.example.com', 'a.example.net', 'b', '192.0.2.1', 'X', 'X (a)', 'X (a.example.com)', 'X (192.0.2.1)', 'Y', 'a (b)'];
    const ALIASES = ['X', 'Y', 'a', 'b', 'X (a)'];
    let seed = 12345;
    const rnd = (n: number): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
    };
    let bad = '';
    for (let t = 0; t < 400 && bad === ''; t += 1) {
        const raws: string[] = [];
        const want = 1 + rnd(6);
        while (raws.length < want) {
            const v = POOL[rnd(POOL.length)];
            if (raws.indexOf(v) === -1) {
                raws.push(v);
            }
        }
        const amap: { [k: string]: string } = {};
        raws.forEach((v) => {
            if (rnd(3) > 0) {
                amap[v] = ALIASES[rnd(ALIASES.length)];
            }
        });
        const names = ha.aliasDisplayNames(raws, (v: string) => (v in amap ? amap[v] : null));
        const unique = names.length === raws.length && names.every((nm: string, i: number) => names.indexOf(nm) === i);
        const rawKept = raws.every((v, i) => v in amap || names[i] === v);
        if (!unique || !rawKept) {
            bad = `${show(raws)} ${show(amap)} -> ${show(names)}`;
        }
    }
    check('D7 distinct raw values give distinct names; unaliased values stay raw', bad === '', bad);
    check('D8 formatAliasLabel', ha.formatAliasLabel('Payroll', 'app01') === 'Payroll (app01)' && ha.formatAliasLabel(null, 'app01') === 'app01',
        '');

    // aliasHostColumn: a link graph's host column, one entry per row, hosts repeating.
    const dn = (raws: string[]): string[] => ha.aliasDisplayNames(raws, res);
    const col = ha.aliasHostColumn(['app01.example.com', 'x', 'app01.example.com', '192.0.2.10', 'other'], dn);
    check('D9 aliasHostColumn: names over the distinct hosts; every row of one host gets one name',
        same(col, ['Billing App (app01)', 'y', 'Billing App (app01)', 'Billing App (192.0.2.10)', 'other']), show(col));
    const rep = ha.aliasHostColumn(['z', 'z', 'a', 'z'], dn);
    check('D9 a host repeated over rows is not a collision: it keeps its plain name', same(rep, ['Z', 'Z', 'a', 'Z']), show(rep));
    const calls: string[][] = [];
    ha.aliasHostColumn(['b', 'a', 'b', 'c', 'a'], (raws: string[]) => {
        calls.push(raws.slice());
        return raws.slice();
    });
    check('D9 displayNames gets each distinct host once, in first-seen order', same(calls, [['b', 'a', 'c']]), show(calls));
    const shortNames = ha.aliasHostColumn(['a', 'b'], () => ['X']);
    check('D9 names not one per distinct host: the raw column', same(shortNames, ['a', 'b']), show(shortNames));
    const shared = ha.aliasHostColumn(['a', 'b', 'a'], () => ['X', 'X']);
    check('D9 names not distinct: the raw column (two hosts never merge into one node)', same(shared, ['a', 'b', 'a']), show(shared));
    const input = ['a', 'b'];
    const copy = ha.aliasHostColumn(input, (raws: string[]) => raws.slice());
    check('D9 a new array; the caller\'s column is not changed', copy !== input && same(copy, ['a', 'b']) && same(input, ['a', 'b']),
        show(copy));
    check('D9 an empty column', same(ha.aliasHostColumn([], dn), []), '');
    // Equal raw values get equal names, distinct raw values distinct names, unaliased values their raw value.
    let badCol = '';
    for (let t = 0; t < 300 && badCol === ''; t += 1) {
        const column: string[] = [];
        const want = 1 + rnd(9);
        while (column.length < want) {
            column.push(POOL[rnd(POOL.length)]);
        }
        const cmap: { [k: string]: string } = {};
        POOL.forEach((v) => {
            if (rnd(3) > 0) {
                cmap[v] = ALIASES[rnd(ALIASES.length)];
            }
        });
        const out = ha.aliasHostColumn(column, (raws: string[]) =>
            ha.aliasDisplayNames(raws, (v: string) => (v in cmap ? cmap[v] : null)));
        const okCol = out.length === column.length
            && column.every((v, i) => (v in cmap || out[i] === v)
                && column.every((w, j) => (v === w) === (out[i] === out[j])));
        if (!okCol) {
            badCol = `${show(column)} ${show(cmap)} -> ${show(out)}`;
        }
    }
    check('D10 aliasHostColumn: equal hosts, equal names; distinct hosts, distinct names; unaliased hosts raw', badCol === '', badCol);
}

/* ---- V the chart series names (utils/aliasSeries.ts, TimeSeriesChart's aliasSeries) ---- */
{
    const vmap: { [raw: string]: string } = {
        'app01.example.com': 'Payroll',
        'other.corp.example': 'Mail Relay',
        'null.corp.example': 'Null Box',
        db03: 'DB',
        db04: 'DB',
    };
    const vres = (raw: string): string | null => (Object.prototype.hasOwnProperty.call(vmap, raw) ? vmap[raw] : null);
    const namer = (raws: string[]): string[] => ha.aliasDisplayNames(raws, vres);
    const vk = ['app01.example.com', 'db02'];
    const none = asr.shownSeriesNames(vk, null);
    check('V1 without a namer: the value fields themselves (the same array) and no map', none.shownKeys === vk
        && none.shownByRaw === null, show(none));
    const named = asr.shownSeriesNames(['app01.example.com', 'db02', 'db03', 'db04'], namer);
    check('V2 with a namer: each field its name, shownByRaw maps raw to shown', same(named.shownKeys,
        ['Payroll', 'db02', 'DB (db03)', 'DB (db04)']) && same(named.shownByRaw, { 'app01.example.com': 'Payroll', db02: 'db02',
        db03: 'DB (db03)', db04: 'DB (db04)' }), show(named));
    // R2: Splunk's own OTHER and NULL series add up many hosts, so they never take a host's name, and are never
    // handed to the namer.
    const seen: string[][] = [];
    const spy = (raws: string[]): string[] => {
        seen.push(raws.slice());
        return namer(raws);
    };
    const other = asr.shownSeriesNames(['app01.example.com', 'db02', 'OTHER'], spy);
    check('V3 OTHER keeps its name, the hosts get theirs', same(other.shownKeys, ['Payroll', 'db02', 'OTHER']), show(other));
    const nul = asr.shownSeriesNames(['NULL', 'app01.example.com'], spy);
    check('V3 NULL keeps its name, the hosts get theirs', same(nul.shownKeys, ['NULL', 'Payroll']), show(nul));
    check('V3 the namer is never handed OTHER or NULL', seen.length === 2
        && seen.every((raws) => raws.indexOf('OTHER') === -1 && raws.indexOf('NULL') === -1), show(seen));
    const lower = asr.shownSeriesNames(['other.corp.example', 'null.corp.example'], namer);
    check('V3 a host named like other / null is still a host', same(lower.shownKeys, ['Mail Relay', 'Null Box']), show(lower));
    check('V3 the reserved names, exact case', same(Array.from(asr.SPLUNK_SERIES_NAMES), ['OTHER', 'NULL'])
        && asr.isSplunkSeriesName('OTHER') && asr.isSplunkSeriesName('NULL') && !asr.isSplunkSeriesName('other')
        && !asr.isSplunkSeriesName('Null'), '');
    const clash = asr.shownSeriesNames(['h1', 'OTHER'], () => ['OTHER']);
    check('V3 a host named "OTHER" beside the OTHER series: every series raw (two never merge)',
        same(clash.shownKeys, ['h1', 'OTHER']), show(clash));
    const shortWithOther = asr.shownSeriesNames(['h1', 'h2', 'OTHER'], () => ['X']);
    check('V3 a namer that gives the wrong number of names, OTHER present: every series raw',
        same(shortWithOther.shownKeys, ['h1', 'h2', 'OTHER']), show(shortWithOther));
    // The fallback: one bad name and EVERY series keeps its raw name.
    const FALLBACK: Array<[string, string[], string[]]> = [
        ['a name starting with "_" (Splunk treats the field as internal)', ['h1', 'h2'], ['_hidden', 'B']],
        ['an empty name', ['h1', 'h2'], ['', 'B']],
        ['two equal names', ['h1', 'h2'], ['X', 'X']],
        ['too few names', ['h1', 'h2'], ['X']],
        ['too many names', ['h1', 'h2'], ['X', 'Y', 'Z']],
    ];
    FALLBACK.forEach(([what, keys, names]) => {
        const got = asr.shownSeriesNames(keys, () => names.slice());
        check(`V4 ${what}: every series keeps its raw name`, same(got.shownKeys, keys)
            && same(got.shownByRaw, keys.reduce((acc: any, k: string) => ({ ...acc, [k]: k }), {})), show(got));
    });
    const underscoreRaw = asr.shownSeriesNames(['_x', 'h2'], () => ['_x', 'B']);
    check('V4 a raw field of its own that starts with "_" keeps it, the others are named', same(underscoreRaw.shownKeys, ['_x', 'B']),
        show(underscoreRaw));
    // rowsToColumnar: the fields carry the shown names, the values are read under the RAW names (a value read under a
    // shown name would draw that series empty).
    const rowsV = [{ _time: 't1', 'app01.example.com': 5, db02: 7 }, { _time: 't2', 'app01.example.com': null }];
    const col = asr.rowsToColumnar(rowsV, ['_time', 'app01.example.com', 'db02'], ['_time', 'Payroll', 'db02']);
    check('V5 rowsToColumnar: shown names as fields, values read under the raw names, missing as null',
        same(col.fields, [{ name: '_time' }, { name: 'Payroll' }, { name: 'db02' }])
        && same(col.columns, [['t1', 't2'], [5, null], [7, null]]), show(col));
    const plain = asr.rowsToColumnar(rowsV, ['_time', 'db02']);
    check('V5 rowsToColumnar without shown names: the field names', same(plain.fields, [{ name: '_time' }, { name: 'db02' }])
        && same(plain.columns, [['t1', 't2'], [7, null]]), show(plain));
    const colors = asr.withShownNames({ 'app01.example.com': '#111', db02: '#222', zz: '#333' },
        { 'app01.example.com': 'Payroll', db02: 'db02', other: 'Other Name' });
    check('V6 withShownNames copies a colour to the shown name only where it differs, keeps the raw keys', same(colors,
        { 'app01.example.com': '#111', db02: '#222', zz: '#333', Payroll: '#111' }), show(colors));
    const base = { a: '#1' };
    asr.withShownNames(base, { a: 'A' });
    check('V6 withShownNames returns a copy', same(base, { a: '#1' }), show(base));
    // The module is pure and imports nothing (so it is no importer of an alias module, Q9).
    const seriesSrc = read(path.join(HOME, 'utils/aliasSeries.ts'));
    check('V7 aliasSeries.ts imports nothing', !/^\s*import\b/m.test(seriesSrc) && !/\brequire\(/.test(seriesSrc), 'it must stay pure');
}

/* ---- E the editor's decisions (utils/hostAliasEditor.ts) ---- */
{
    const row = (matchValue: string, alias: string, extra: { [k: string]: unknown } = {}): any =>
        ({ ...ha.sanitizeAliasRow({ match_value: matchValue, alias, ...extra }), ...extra });
    const tableOf = (rows: any[], extra: { [k: string]: unknown } = {}): any =>
        ({ rows, complete: true, storedCount: rows.length, invalidCount: 0, ...extra });
    const parsedRows = (csv: string): any[] => {
        const res = ha.parseAliasCsv(csv);
        if (res.errors.length > 0) {
            throw new Error(`fixture does not parse: ${show(res.errors)}`);
        }
        return res.rows;
    };

    check('E1 the limits and formats', he.MAX_IMPORT_BYTES === 2 * 1024 * 1024 && he.LISTED_ROWS === 100
        && he.fmtCount(5000) === '5,000' && he.fmtCount(12) === '12' && he.fmtSize(2 * 1024 * 1024 + 1) === '2.0 MB'
        && he.fmtSize(1500) === '2 KB', show([he.MAX_IMPORT_BYTES, he.LISTED_ROWS, he.fmtSize(2 * 1024 * 1024 + 1)]));

    // E2 adds: every host not in the table, in file order, written with the file's description.
    const stored = [row('app01', 'Payroll', { description: 'prod' }), row('db01.example.com', 'Billing DB'),
        row('192.0.2.10', 'Edge')];
    const t = tableOf(stored);
    const p2 = he.planImport(parsedRows('host,alias,description\nnew01,New One,d1\nnew02.example.com,New Two,\n'), t);
    check('E2 adds: counted, listed in file order and written', p2.added === 2 && p2.renamed === 0 && p2.describedOnly === 0
        && p2.unchanged === 0 && p2.capacityError === null
        && same(p2.adds.map((x: any) => [x._key, x.match_value, x.alias, x.description]),
            [['new01', 'new01', 'New One', 'd1'], ['new02.example.com', 'new02.example.com', 'New Two', '']])
        && same(p2.toWrite, p2.adds), show(p2));

    // E3 renames: a host whose name differs is changed; the preview line names the old and the new name.
    const p3 = he.planImport(parsedRows('host,alias,description\nAPP01,Payroll App,\n192.0.2.10,Edge,\n'), t);
    check('E3 renames: counted and listed "host: old -> new"; the unchanged host is not written', p3.renamed === 1
        && p3.unchanged === 1 && p3.added === 0 && same(p3.renames, [{ host: 'APP01', oldAlias: 'Payroll', newAlias: 'Payroll App' }])
        && same(he.renameLines(p3), ['APP01: Payroll -> Payroll App']) && p3.toWrite.length === 1
        && p3.toWrite[0]._key === 'app01' && p3.toWrite[0].match_value === 'APP01', show(p3));

    // E4 a description-only change is written but is no rename.
    const p4 = he.planImport(parsedRows('host,alias,description\napp01,Payroll,new desc\ndb01.example.com,Billing DB,first\n'), t);
    check('E4 description-only changes: written, counted apart, not in the renames', p4.describedOnly === 2 && p4.renamed === 0
        && p4.renames.length === 0 && same(p4.toWrite.map((x: any) => x.description), ['new desc', 'first'])
        && he.importConfirmText(p4) === null, show(p4));

    // E5 the empty-description merge: an empty cell keeps the stored description, also on a rename.
    const p5 = he.planImport(parsedRows('host,alias,description\napp01,Payroll,\napp01.example.org,X,\n'), t);
    const p5b = he.planImport(parsedRows('host,alias,description\napp01,Renamed,\n'), t);
    check('E5 an empty description keeps the stored one: unchanged, and on a rename the stored text is written',
        p5.unchanged === 1 && p5.added === 1 && p5.toWrite.length === 1 && p5.toWrite[0]._key === 'app01.example.org'
        && p5b.renamed === 1 && p5b.toWrite[0].description === 'prod', show([p5, p5b]));

    // E6 capacity counts the STORED rows, valid or not.
    const many = (n: number): any[] => {
        const out: any[] = [];
        for (let i = 0; i < n; i += 1) {
            out.push({ _key: `h${i}`, match_value: `h${i}`, alias: `N${i}` });
        }
        return out;
    };
    const valid4990 = many(4990);
    const full = tableOf(valid4990, { storedCount: 5000, invalidCount: 10 });
    const room1 = tableOf(valid4990, { storedCount: 4999, invalidCount: 9 });
    const addOne = parsedRows('host,alias\nbrandnew,X\n');
    const addTwo = parsedRows('host,alias\nbrandnew,X\nbrandnew2,Y\n');
    check('E6 storedTotal counts the invalid rows too', he.storedTotal(full) === 5000 && he.storedTotal(room1) === 4999
        && he.storedTotal(tableOf(valid4990, { storedCount: 0, invalidCount: 10 })) === 5000 && he.isTableFull(full)
        && !he.isTableFull(room1), show([he.storedTotal(full), he.storedTotal(room1)]));
    const capFull = he.planImport(addOne, full);
    check('E6 an import that would pass 5,000 stored rows (10 of them invalid) is refused, in the singular and the plural',
        capFull.capacityError === 'The file adds 1 host to the 5,000 rows stored in the table; the table holds at most 5,000.'
        && he.planImport(addTwo, full).capacityError
            === 'The file adds 2 hosts to the 5,000 rows stored in the table; the table holds at most 5,000.',
        show([capFull.capacityError, he.planImport(addTwo, full).capacityError]));
    check('E6 one place left: one add fits, two do not', he.planImport(addOne, room1).capacityError === null
        && he.planImport(addTwo, room1).capacityError !== null, '');
    const renameOnly = he.planImport(parsedRows('host,alias\nh1,Other\n'), full);
    check('E6 a full table still takes renames (no add)', renameOnly.capacityError === null && renameOnly.renamed === 1
        && renameOnly.rekeyed === 0, show(renameOnly));
    // A host whose row in effect is stored under a foreign key: an import that changes it writes a NEW row under the
    // host's own key, and the old row stays (an import deletes nothing), so that row counts against capacity.
    const foreignH1 = { ...row('h1', 'N1'), stored_key: 'foreign-h1' };
    const foreignRows = valid4990.filter((x: any) => x._key !== 'h1').concat([foreignH1]);
    const fullF = tableOf(foreignRows, { storedCount: 5000, invalidCount: 10 });
    const roomF = tableOf(foreignRows, { storedCount: 4999, invalidCount: 9 });
    const renameF = he.planImport(parsedRows('host,alias\nh1,Other\n'), fullF);
    const REKEY_ONE = '1 host in the file has a row written outside this page: the import writes it under its own key, a new row,'
        + ' and the old one stays.';
    check('E6 a rename of a host stored under a foreign key counts its new row: refused in a full table',
        renameF.renamed === 1 && renameF.rekeyed === 1 && renameF.added === 0 && renameF.capacityError
            === `The file adds 1 row to the 5,000 rows stored in the table; the table holds at most 5,000. ${REKEY_ONE}`,
        show(renameF));
    const descF = he.planImport(parsedRows('host,alias,description\nh1,N1,new\n'), fullF);
    check('E6 a description-only change of such a host counts too', descF.describedOnly === 1 && descF.rekeyed === 1
        && descF.capacityError !== null, show(descF));
    const renameRoom = he.planImport(parsedRows('host,alias\nh1,Other\n'), roomF);
    check('E6 with one place left the rename fits; it writes the derived key only, nothing is deleted or rekeyed back',
        renameRoom.capacityError === null && renameRoom.rekeyed === 1 && renameRoom.toWrite.length === 1
        && renameRoom.toWrite[0]._key === 'h1' && !('stored_key' in renameRoom.toWrite[0]), show(renameRoom));
    const twoNew = he.planImport(parsedRows('host,alias\nh1,Other\nbrandnew,X\n'), roomF);
    check('E6 a rekeyed row and an add: two new rows, one place left: refused', twoNew.capacityError
        === `The file adds 2 rows to the 4,999 rows stored in the table; the table holds at most 5,000. ${REKEY_ONE}`,
        show(twoNew.capacityError));
    const ownBeside = he.planImport(parsedRows('host,alias\nh1,Other\n'),
        tableOf(valid4990.concat([foreignH1]), { storedCount: 5000, invalidCount: 9 }));
    check('E6 a host with a row under its own key (beside a foreign one) is no new row', ownBeside.rekeyed === 0
        && ownBeside.capacityError === null, show(ownBeside));
    const cutF = he.planImport(parsedRows('host,alias\nh1,Other\n'), tableOf(foreignRows, { complete: false, storedCount: 5000 }));
    check('E6 after a read that stopped at 5,000, a rekeyed row is refused too, saying why', cutF.capacityError
        === `The table already holds more than 5,000 rows, so no row can be added. ${REKEY_ONE} Delete rows first.`,
        show(cutF.capacityError));
    const incomplete = he.planImport(addOne, tableOf(valid4990, { complete: false, storedCount: 5000 }));
    check('E6 after a read that stopped at 5,000, no add', /^The table already holds more than 5,000 rows, so no host can be added/
        .test(String(incomplete.capacityError)), show(incomplete.capacityError));
    // An incomplete read is full whatever it counted (the rows past 5,000 were not read).
    const cut6 = tableOf(stored, { complete: false });
    const saveCut = he.planSave(row('brandnew', 'X'), null, cut6);
    check('E6 an incomplete read is full: Save of a new host is refused, saying more than 5,000', he.isTableFull(cut6)
        && saveCut.kind === 'full' && /^The table already holds more than 5,000 rows, the most it can hold/.test(saveCut.message),
        show(saveCut));
    const saveFull = he.planSave(row('brandnew', 'X'), null, full);
    check('E6 Save of a new host into a full table (invalid rows counted) is refused', saveFull.kind === 'full'
        && saveFull.message === 'The table already holds 5,000 rows, the most it can hold. Delete a row before adding a host.',
        show(saveFull));
    check('E6 Save with one place left writes', he.planSave(row('brandnew', 'X'), null, room1).kind === 'write', '');
    const editFull = he.planSave(row('h1', 'Renamed'), { _key: 'h1', match_value: 'h1', alias: 'N1' }, full);
    check('E6 an edit in a full table writes (it adds no row)', editFull.kind === 'write' && editFull.confirmText === null,
        show(editFull));
    check('E6 Save of a host a row already names, into a full table, replaces it (asks, no capacity refusal)',
        he.planSave(row('H1', 'X'), null, full).kind === 'write'
        && /already has the name "N1"/.test(String((he.planSave(row('H1', 'X'), null, full) as any).confirmText)), '');
    // KV-4: a Save that writes to a key no stored row holds adds a row, whatever row names the host, so a full table
    // refuses it (as Import refuses a rekeyed row); with room left it says the old row stays.
    const own4999 = many(4999);
    const fx = ha.sanitizeAliasRow({ _key: 'foreign-x', match_value: 'hx', alias: 'NX' });
    const fullFx = tableOf(own4999.concat([fx]));
    const addOverForeign = he.planSave(row('hx', 'Other'), null, fullFx);
    check('E6 Save over a host whose only row is stored under another key, into a full table: refused (the new row would'
        + ' be row 5,001)', he.storedTotal(fullFx) === 5000 && addOverForeign.kind === 'full' && addOverForeign.message
        === 'The table already holds 5,000 rows, the most it can hold. The host hx has a row written outside this page:'
            + ' saving writes the name under its own key, a new row, and the old one stays. Delete a row first.',
    show(addOverForeign));
    const roomFx = tableOf(many(4998).concat([fx]));
    const addRoom = he.planSave(row('hx', 'Other'), null, roomFx);
    check('E6 the same with room left writes, and the question says the old row stays', addRoom.kind === 'write'
        && addRoom.confirmText === 'The host hx already has the name "NX". Replace it with "Other"? The new name is written'
            + ' under the host\'s own key, a new row, and the row written outside this page stays.'
        && addRoom.row._key === 'hx' && addRoom.removeStoredKey === null, show(addRoom));
    const h1Row = own4999[1];
    const fullOwn = tableOf(many(5000));
    const movedFull = he.planSave(row('brandnew', 'N1'), h1Row, fullOwn);
    check('E6 an edit that moves a row to a new key, in a full table: refused (the new row is written before the old one'
        + ' is removed)', movedFull.kind === 'full' && movedFull.message === 'The table already holds 5,000 rows, the most it'
        + ' can hold. Saving writes brandnew under its own key, a new row, before the entry for h1 is removed. Delete a row'
        + ' first.', show(movedFull));
    const stuck = ha.sanitizeAliasRow({ _key: 'a/b', match_value: 'hy', alias: 'HY' });
    const fullStuck = tableOf(many(4999).concat([stuck]));
    const movedStuck = he.planSave(row('brandnew', 'HY'), stuck, fullStuck);
    check('E6 an edit of a row whose key cannot be deleted, in a full table: refused, saying the old row stays',
        !ha.isDeletableKey('a/b') && movedStuck.kind === 'full' && movedStuck.message === 'The table already holds 5,000 rows,'
        + ' the most it can hold. Saving writes brandnew under its own key, a new row, and the entry for hy stays: its key'
        + ' cannot be deleted from this page. Delete a row first.', show(movedStuck));
    const inPlaceFull = he.planSave(row('h1', 'Renamed'), h1Row, fullOwn);
    check('E6 an edit in place in a full table writes (no new row)', inPlaceFull.kind === 'write'
        && inPlaceFull.removeStoredKey === null && inPlaceFull.confirmText === null, show(inPlaceFull));
    const fixFull = he.planSave(row('hy', 'HY'), stuck, fullStuck);
    check('E6 saving a row written outside this page under its own key, in a full table: refused (the old row would stay'
        + ' beside it)', fixFull.kind === 'full' && /and the entry for hy stays: its key cannot be deleted/.test(fixFull.message),
    show(fixFull));
    // Over the 5,000 rows and their keys, no Save plan that writes adds a row to a full table (a random sweep).
    let seedK = 4242;
    const rndK = (n: number): number => {
        seedK = (seedK * 1103515245 + 12345) % 2147483648;
        return Math.floor(seedK / 65536) % n;
    };
    let badK = '';
    for (let i = 0; i < 400 && badK === ''; i += 1) {
        const base = many(5);
        const rowsK: any[] = base.map((x: any) => (rndK(3) === 0
            ? ha.sanitizeAliasRow({ _key: `f-${x._key}`, match_value: x.match_value, alias: x.alias }) : x));
        if (rndK(2) === 0) {
            rowsK.push(ha.sanitizeAliasRow({ _key: 'h9', match_value: `x${rndK(3)}.example.com`, alias: 'Z' }));
        }
        const tK = tableOf(rowsK, { storedCount: 5000, invalidCount: 5000 - rowsK.length });
        const target = `h${rndK(10)}`;
        const ed = rndK(2) === 0 ? null : rowsK[rndK(rowsK.length)];
        const planK = he.planSave(row(target, `N${rndK(4)}`), ed, tK);
        const storedKeys = rowsK.map((x: any) => he.storedKeyOf(x));
        if (planK.kind === 'write' && storedKeys.indexOf(planK.row._key) === -1) {
            badK = `${show(rowsK)} edit ${show(ed)} -> ${show(planK)}`;
        }
    }
    check('E6 in a full table a Save that writes always writes to a key a stored row holds', badK === '', badK);

    // E7 export -> import: a table with no conflicted host gives nothing to write, foreign rows and descriptions
    // included. (A conflicted host is the case below: its rows give it no name, the export one of them.)
    const roundRows = [row('app01.example.com', 'Billing App', { description: 'Front, end' }), row('192.0.2.10', 'Billing App'),
        row('2001:DB8::1', '"Quoted"'), row('old01', '-old', { description: '=not a formula' }),
        row('u01', `Fakturierung ${ch(0xe4)}`), { ...row('app09', 'Old'), stored_key: 'foreign-9', updated_at: 9 },
        { ...row('app09', 'New'), updated_at: 5 }];
    const roundTable = tableOf(roundRows);
    const exported = ha.toAliasCsv(Array.from(he.effectiveRows(roundRows).values()));
    const reimport = ha.parseAliasCsv(exported);
    const p7 = he.planImport(reimport.rows, roundTable);
    check('E7 export -> import of a table with no conflicted host: no error, no warning, nothing to write',
        he.conflictedKeys(roundRows).size === 0 && reimport.errors.length === 0
        && reimport.warnings.length === 0 && p7.toWrite.length === 0 && p7.unchanged === 6 && p7.added === 0
        && he.isImportBlocked(reimport, p7), show([reimport.errors, p7]));
    // N2: export -> import of a table WITH a conflicted host is no "nothing to write": the export holds the name of
    // the tied row stored under the smallest key (ranksBefore), whatever order the rows were read in, and the import
    // writes that name under the host's own key, shows the conflict line and asks first.
    const cA = ha.sanitizeAliasRow({ _key: 'k2', match_value: 'app01', alias: 'Name A', description: 'from k2', updated_at: 7 });
    const cB = ha.sanitizeAliasRow({ _key: 'k1', match_value: 'APP01', alias: 'Name B', description: 'from k1', updated_at: 7 });
    const cPlain = row('web01', 'Web');
    const conflictRound = (rowsC: any[]): any => {
        const csvC = ha.toAliasCsv(Array.from(he.effectiveRows(rowsC).values()));
        const backC = ha.parseAliasCsv(csvC);
        const planC = he.planImport(backC.rows, tableOf(rowsC));
        return { csvC, errors: backC.errors, planC, question: he.importConfirmText(planC), lines: he.renameLines(planC) };
    };
    const roundC = conflictRound([cA, cB, cPlain]);
    const roundCRev = conflictRound([cPlain, cB, cA]);
    check('E7 export -> import of a table with a conflicted host: that host is written under its own key with the name'
        + ' the export holds (the tied row under the smallest key), shown as a conflict line, and Import asks; the same in'
        + ' either read order', same(Array.from(he.conflictedKeys([cA, cB])), ['app01']) && roundC.errors.length === 0
        && /\r\nAPP01,Name B,from k1\r\n/.test(roundC.csvC) && roundC.planC.toWrite.length === 1
        && roundC.planC.toWrite[0]._key === 'app01' && roundC.planC.toWrite[0].alias === 'Name B'
        && roundC.planC.toWrite[0].description === 'from k1' && roundC.planC.renamed === 1 && roundC.planC.rekeyed === 1
        && roundC.planC.unchanged === 1 && same(roundC.lines, ['APP01: no name (its rows give Name A / Name B) -> Name B'])
        && roundC.question === '1 name will change. This cannot be undone. Import?' && same(roundC, roundCRev),
    show([roundC, roundCRev]));
    check('E7 the export carries the row the dashboards use (the one under its own key)', /app09,New,/.test(exported)
        && !/app09,Old/.test(exported), exported);

    // E8 an exact repeat in the file warns and is skipped: it neither blocks Import nor writes twice.
    const rep8 = ha.parseAliasCsv('host,alias,description\nnew10,Ten,d\nNEW10.,Ten,\nnew10,Ten,d\n');
    const p8 = he.planImport(rep8.rows, t);
    check('E8 an exact repeat: one row written, the repeats only warned, Import allowed', rep8.errors.length === 0
        && rep8.warnings.length === 2 && p8.toWrite.length === 1 && p8.added === 1 && !he.isImportBlocked(rep8, p8), show([rep8, p8]));
    const conflict8 = ha.parseAliasCsv('host,alias\nnew11,A\nnew11,B\n');
    check('E8 two names for one host still block Import', he.isImportBlocked(conflict8, he.planImport(conflict8.rows, t)),
        show(conflict8));

    // E9 U+FFFD blocks Import; E10 a semicolon file too.
    const fffd9 = ha.parseAliasCsv(`host,alias\nnew12,Z${ch(0xfffd)}rich\nnew13,Fine\n`);
    check('E9 a line with U+FFFD is refused and blocks Import', fffd9.errors.length === 1 && fffd9.errors[0].line === 2
        && he.isImportBlocked(fffd9, he.planImport(fffd9.rows, t)), show(fffd9));
    const semi10 = ha.parseAliasCsv('host;alias\nnew14;X\n');
    check('E10 a semicolon file blocks Import, the error names the separator', he.isImportBlocked(semi10, he.planImport(semi10.rows, t))
        && semi10.errors[0].message.indexOf('separate the columns with commas') !== -1, show(semi10));
    check('E10 isImportBlocked: nothing previewed, a capacity error or nothing to write', he.isImportBlocked(null, null)
        && he.isImportBlocked(ha.parseAliasCsv('host,alias\nbrandnew,X\n'), capFull)
        && he.isImportBlocked(reimport, p7) && !he.isImportBlocked(ha.parseAliasCsv('host,alias\nnew15,X\n'), p2), '');

    // E11 the preview lists, the questions and the count line.
    const fake = (n: number): any => ({ renamed: n, renames: [], adds: [] });
    check('E11 Import asks only when a name changes: "N names will change. This cannot be undone. Import?"',
        he.importConfirmText(fake(0)) === null && he.importConfirmText(fake(1)) === '1 name will change. This cannot be undone. Import?'
        && he.importConfirmText(fake(1234)) === '1,234 names will change. This cannot be undone. Import?'
        && he.importConfirmText(p3) === '1 name will change. This cannot be undone. Import?', show(he.importConfirmText(fake(1234))));
    const lines250: string[] = [];
    for (let i = 0; i < 250; i += 1) {
        lines250.push(`l${i}`);
    }
    const cut = he.firstLines(lines250);
    check('E11 the lists show the first 100, then "and N more"', cut.lines.length === 100 && cut.lines[99] === 'l99' && cut.more === 150
        && he.moreText(cut.more) === 'and 150 more' && he.firstLines(['a']).more === 0 && he.moreText(1500) === 'and 1,500 more',
        show([cut.more, he.moreText(cut.more)]));
    check('E11 the add lines read "host: name"', same(he.addLines(p2), ['new01: New One', 'new02.example.com: New Two']),
        show(he.addLines(p2)));
    check('E11 the count line: the stored rows, and the rows that cannot be shown', he.countLineText(tableOf(stored)) === '3 of 5,000'
        && he.countLineText(tableOf(stored, { storedCount: 4, invalidCount: 1 }))
            === '4 of 5,000 (1 stored row cannot be shown here; remove it with the KV Store REST API)'
        && he.countLineText(full) === '5,000 of 5,000 (10 stored rows cannot be shown here; remove them with the KV Store REST API)',
        he.countLineText(full));
    check('E11 a failed batch in words', he.describeFailure({ from: 1000, to: 2000, message: 'HTTP 500' },
        many(2500)) === 'Rows 1,001-2,000 of 2,500 (h1000 to h1999): HTTP 500', he.describeFailure({ from: 1000, to: 2000,
        message: 'HTTP 500' }, many(2500)));

    // E12 Save's plan and the form checks.
    const editing = { _key: 'app01', match_value: 'app01', alias: 'Payroll', description: 'prod' };
    check('E12 an edit that changes nothing', he.planSave(row('app01', 'Payroll', { description: 'prod' }), editing, t).kind === 'unchanged',
        '');
    const moved = he.planSave(row('app02', 'Payroll'), editing, t);
    check('E12 an edit to another host value writes, then removes the old key', moved.kind === 'write' && moved.confirmText === null
        && moved.removeStoredKey === 'app01', show(moved));
    const sameKey = he.planSave(row('APP01', 'Payroll 2'), editing, t);
    check('E12 an edit under the same key removes nothing', sameKey.kind === 'write' && sameKey.removeStoredKey === null
        && sameKey.confirmText === null, show(sameKey));
    const onto = he.planSave(row('db01.example.com', 'Payroll'), editing, t);
    check('E12 an edit onto a host another row names asks first, naming both, and then removes the old row',
        onto.kind === 'write' && onto.confirmText === 'The host db01.example.com already has the name "Billing DB". '
        + 'Replace it with "Payroll"? The entry for app01 is then removed.' && onto.removeStoredKey === 'app01', show(onto));
    const ownRow = { _key: 'app09', match_value: 'app09', alias: 'New' };
    const foreignOld = { _key: 'app09', match_value: 'app09', alias: 'Old', stored_key: 'foreign-9' };
    const ownEdit = he.planSave(row('app09', 'Newer'), ownRow, tableOf([ownRow, foreignOld]));
    check('E12 an edit under its own key beside a foreign row asks, without saying a row is removed (none is)',
        ownEdit.kind === 'write' && ownEdit.removeStoredKey === null
        && ownEdit.confirmText === 'The host app09 already has the name "Old". Replace it with "Newer"?', show(ownEdit));
    check('E12 an add onto a host a row already names asks, without saying a row is removed',
        (he.planSave(row('H1', 'X'), null, full) as any).confirmText === 'The host h1 already has the name "N1". Replace it with "X"?',
        show(he.planSave(row('H1', 'X'), null, full)));
    const foreignEdit = { _key: 'app09', match_value: 'app09', alias: 'Old', stored_key: 'foreign-9' };
    const fixForeign = he.planSave(row('app09', 'Old'), foreignEdit, tableOf([foreignEdit]));
    check('E12 saving a row stored under a foreign key rewrites it under its own key and removes the foreign one',
        fixForeign.kind === 'write' && fixForeign.removeStoredKey === 'foreign-9', show(fixForeign));
    // KV-1: a write that replaces another row whole keeps that row's description when the form leaves it empty.
    const form = (h: string, a: string, d = ''): any => he.checkForm(h, a, d).row;
    const db01 = ha.sanitizeAliasRow({ _key: 'db01', match_value: 'db01', alias: 'DB', description: 'keep me' });
    const keep = he.planSave(form('DB01', 'DB2'), null, tableOf([db01]));
    check('E12 an add over a host that has a row keeps its description when the form leaves it empty (KV-1)',
        keep.kind === 'write' && keep.row._key === 'db01' && keep.row.description === 'keep me'
        && keep.confirmText === 'The host db01 already has the name "DB". Replace it with "DB2"?', show(keep));
    const given = he.planSave(form('DB01', 'DB2', 'new d'), null, tableOf([db01]));
    check('E12 a description in the form is written as given', given.kind === 'write' && given.row.description === 'new d', show(given));
    const app01d = ha.sanitizeAliasRow({ _key: 'app01', match_value: 'app01', alias: 'App', description: 'app01 desc' });
    const app02 = ha.sanitizeAliasRow({ _key: 'app02', match_value: 'app02', alias: 'Two' });
    const movedOnto = he.planSave(form('app01', 'Two'), app02, tableOf([app01d, app02]));
    check('E12 an edit moved onto another host\'s value keeps that row\'s description', movedOnto.kind === 'write'
        && movedOnto.row.description === 'app01 desc' && movedOnto.removeStoredKey === 'app02', show(movedOnto));
    const cleared = he.planSave(form('db01', 'DB'), db01, tableOf([db01]));
    check('E12 an edit in place that clears the description clears it, without a question', cleared.kind === 'write'
        && !cleared.row.description && cleared.confirmText === null && cleared.removeStoredKey === null, show(cleared));
    const beside = he.planSave(row('app09', 'Newer'), ownRow, tableOf([ownRow, { ...foreignOld, description: 'old d' }]));
    check('E12 an edit in place beside a foreign row carries nothing, and asks as before', beside.kind === 'write'
        && !beside.row.description && beside.confirmText === 'The host app09 already has the name "Old". Replace it with "Newer"?',
    show(beside));
    const plainForm = form('brandnew', 'X');
    const plainPlan = he.planSave(plainForm, null, tableOf([db01]));
    check('E12 with nothing carried the plan writes the form\'s row itself', plainPlan.kind === 'write' && plainPlan.row === plainForm,
        show(plainPlan));
    // KV-2: a row of ANOTHER host written outside this page under the key the write uses is replaced whole: Save asks
    // and names it, and adds no row.
    const outside = ha.sanitizeAliasRow({ _key: 'app01', match_value: 'app01.example.com', alias: 'Payroll', description: 'prod payroll' });
    const replaceOutside = he.planSave(form('app01', 'Short'), null, tableOf([outside]));
    check('E12 Save of a host whose key holds another host\'s row asks first and names it (KV-2)', replaceOutside.kind === 'write'
        && replaceOutside.confirmText === 'Saving app01 replaces the entry for app01.example.com, named "Payroll", which was'
            + ' written outside this page under the key app01. Replace it?'
        && !replaceOutside.row.description && replaceOutside.removeStoredKey === null, show(replaceOutside));
    const replaceFull = he.planSave(form('app01', 'Short'), null, tableOf([outside], { storedCount: 5000, invalidCount: 4999 }));
    check('E12 that write adds no row, so a full table takes it', replaceFull.kind === 'write', show(replaceFull));
    const hxForeign = ha.sanitizeAliasRow({ _key: 'objid-1', match_value: 'hx', alias: 'NX' });
    const hxHolder = ha.sanitizeAliasRow({ _key: 'hx', match_value: 'hx.example.com', alias: 'HXF' });
    const both = he.planSave(form('hx', 'Other'), null, tableOf([hxForeign, hxHolder]));
    check('E12 a host named by a foreign row whose key holds another host\'s row: one question names both', both.kind === 'write'
        && both.confirmText === 'The host hx already has the name "NX". Replace it with "Other"? Saving also replaces the entry'
            + ' for hx.example.com, named "HXF", which was written outside this page under the key hx.', show(both));
    const movedReplace = he.planSave(form('app01', 'Short'), app02, tableOf([outside, app02]));
    check('E12 an edit moved onto a key another host\'s row holds: asks, names it, then removes the old entry',
        movedReplace.kind === 'write' && movedReplace.removeStoredKey === 'app02' && movedReplace.confirmText
        === 'Saving app01 replaces the entry for app01.example.com, named "Payroll", which was written outside this page'
            + ' under the key app01. Replace it? The entry for app02 is then removed.', show(movedReplace));
    const editHolder = he.planSave(form('app01.example.com', 'Payroll 2'), outside, tableOf([outside]));
    check('E12 an edit of the row stored under the other host\'s key itself names no replaced row', editHolder.kind === 'write'
        && editHolder.removeStoredKey === 'app01' && editHolder.confirmText === null, show(editHolder));
    const okForm = he.checkForm(' 192.000.002.010 ', ' Payroll ', '');
    check('E12 checkForm: a valid row and what it covers', okForm.row !== null && okForm.row._key === '192.0.2.10'
        && okForm.host === null && okForm.covers === 'Matches the IP address 192.0.2.10 only.', show(okForm));
    check('E12 checkForm: a short name covers its fully qualified names', /^Matches app01 and its fully qualified names/
        .test(String(he.checkForm('app01', 'X', '').covers)), '');
    const badForm = he.checkForm('http://app01', `Pay${ch(0x200b)}roll`, '<b>');
    check('E12 checkForm: each field\'s problem, no row', badForm.row === null && badForm.host === he.NOT_A_HOST_TEXT
        && badForm.alias === he.FORBIDDEN_TEXT && badForm.description === 'Cannot hold < or >.'
        && he.checkForm('', '', '').host !== null && he.checkForm('app01', ch(0x2800), '').alias === 'Needs at least one character that shows.'
        && he.checkForm('app01', repeat('x', 65), '').alias === 'At most 64 characters (this has 65).', show(badForm));

    // E13 the row in effect is the one the dashboards use (buildAliasIndex's order), over a sweep.
    let seedE = 777;
    const rndE = (n: number): number => {
        seedE = (seedE * 1103515245 + 12345) % 2147483648;
        // The high bits: an LCG's low bits repeat with a short period (the lowest one alternates).
        return Math.floor(seedE / 65536) % n;
    };
    let badE = '';
    for (let i = 0; i < 300 && badE === ''; i += 1) {
        const rowsE: any[] = [];
        const n = 1 + rndE(4);
        for (let j = 0; j < n; j += 1) {
            const one: any = { _key: 'app77', match_value: rndE(2) ? 'APP77' : 'app77', alias: `A${rndE(5)}`, updated_at: 1 + rndE(4) };
            if (rndE(2)) {
                one.stored_key = `foreign-${j}`;
            }
            rowsE.push(one);
        }
        const viaIndex = ha.resolveAlias(ha.buildAliasIndex(rowsE), 'app77');
        const viaEditor = he.effectiveRows(rowsE).get('app77').alias;
        const conflicted = he.conflictedKeys(rowsE).has('app77');
        // buildAliasIndex gives no alias on a tie with different aliases (conflictedKeys names exactly those keys);
        // otherwise both must name the same row.
        if (conflicted !== (viaIndex === null) || (viaIndex !== null && viaIndex !== viaEditor)) {
            badE = `${show(rowsE)} index ${viaIndex}, editor ${viaEditor}, conflicted ${conflicted}`;
        }
    }
    check('E13 effectiveRows picks the row resolveAlias uses (own key first, then the later write)', badE === '', badE);
    const ownFirst = he.effectiveRows([{ _key: 'a', match_value: 'a', alias: 'own', updated_at: 1 },
        { _key: 'a', match_value: 'A', alias: 'foreign', stored_key: 'f', updated_at: 9 },
        { _key: 'b', match_value: 'b', alias: 'later', updated_at: 5 }, { _key: 'b', match_value: 'B', alias: 'earlier', updated_at: 2 }]);
    check('E13 effectiveRows: the row under its own key wins in any order; then the later write, also when it comes first',
        ownFirst.get('a').alias === 'own' && ownFirst.get('b').alias === 'later' && ownFirst.size === 2,
        show(Array.from(ownFirst.values())));
    check('E13 winsOver', he.winsOver({ _key: 'a', match_value: 'a', alias: 'x' }, { _key: 'a', match_value: 'a', alias: 'y',
        stored_key: 'f', updated_at: 9 }) && !he.winsOver({ _key: 'a', match_value: 'a', alias: 'x', updated_at: 1 },
        { _key: 'a', match_value: 'a', alias: 'y', updated_at: 2 }), '');

    // E14 the list's filter and order.
    const listed = he.listRows([row('h10', 'Beta', { description: 'Prod' }), row('h9', 'alpha'), row('h2', 'Beta')], 'beta', 'alias', 1)
        .map((x: any) => x.match_value);
    check('E14 listRows: filter in any case, by name then host, natural order', same(listed, ['h2', 'h10']), show(listed));
    const byDesc = he.listRows([row('h10', 'Beta', { description: 'Prod' }), row('h9', 'alpha'), row('h2', 'Beta')], 'PROD', 'alias', 1)
        .map((x: any) => x.match_value);
    check('E14 listRows: the filter finds a description too', same(byDesc, ['h10']), show(byDesc));
    check('E14 listRows: by host, descending', same(he.listRows([row('h10', 'B'), row('h9', 'A'), row('h2', 'C')], '', 'host', -1)
        .map((x: any) => x.match_value), ['h10', 'h9', 'h2']), '');
    check('E14 the input files: the import text limits', he.importTextProblem('  ') === 'Choose a CSV file or paste its text first.'
        && he.importTextProblem(repeat('x', he.MAX_IMPORT_BYTES + 1)) === 'The text is larger than 2 MB. Split it into smaller files.'
        && he.importTextProblem('host,alias') === null && he.importFileProblem('big.csv', he.MAX_IMPORT_BYTES + 1)
            === 'big.csv is 2.0 MB; a file can be at most 2 MB.' && he.importFileProblem('ok.csv', 10) === null
        && he.importFileProblem('exact.csv', he.MAX_IMPORT_BYTES) === null
        && he.importTextProblem(repeat('x', he.MAX_IMPORT_BYTES)) === null, 'a file or a text of exactly 2 MB is read');

    // E17 Import over a row of ANOTHER host stored under a file host's key (KV-2): replaced, named, asked, no add.
    const outsideI = ha.sanitizeAliasRow({ _key: 'app01', match_value: 'app01.example.com', alias: 'Payroll', description: 'prod payroll' });
    const p17 = he.planImport(parsedRows('host,alias\napp01,Short\n'), tableOf([outsideI]));
    check('E17 an import line whose key holds another host\'s row: replaced, not added (KV-2)', p17.added === 0 && p17.replaced === 1
        && p17.rekeyed === 0 && p17.toWrite.length === 1 && p17.capacityError === null && p17.adds.length === 0
        && same(p17.replaces, [{ host: 'app01', newAlias: 'Short', key: 'app01', oldHost: 'app01.example.com', oldAlias: 'Payroll' }]),
    show(p17));
    check('E17 Import asks, naming the replaced row', he.importConfirmText(p17) === '1 row written outside this page under the key'
        + ' of a host in the file is replaced: app01.example.com ("Payroll"), stored under the key app01. This cannot be undone.'
        + ' Import?' && same(he.replaceLines(p17), ['app01: Short, replacing app01.example.com: Payroll (key app01)']),
    show([he.importConfirmText(p17), he.replaceLines(p17)]));
    const p17b = he.planImport(parsedRows('host,alias\napp01,Short\napp01.example.com,Payroll\n'), tableOf([outsideI]));
    check('E17 a host the file gives unchanged whose row another line replaces is written under its own key, keeping its'
        + ' description', p17b.replaced === 1 && p17b.added === 1 && p17b.unchanged === 0 && p17b.toWrite.length === 2
        && p17b.toWrite[1]._key === 'app01.example.com' && p17b.toWrite[1].description === 'prod payroll', show(p17b));
    const sevenRows: any[] = [];
    const sevenLines = ['host,alias'];
    for (let i = 0; i < 7; i += 1) {
        sevenRows.push(ha.sanitizeAliasRow({ _key: `s${i}`, match_value: `s${i}.example.com`, alias: `Old ${i}` }));
        sevenLines.push(`s${i},New ${i}`);
    }
    const p17c = he.planImport(parsedRows(sevenLines.join('\n')), tableOf(sevenRows));
    const q17c = String(he.importConfirmText(p17c));
    check('E17 seven replaced rows: the question names five, then "and 2 more"', p17c.replaced === 7
        && /^7 rows written outside this page under the keys of hosts in the file are replaced: s0\.example\.com \("Old 0"\),/
            .test(q17c) && (q17c.match(/stored under the key/g) || []).length === 5
        && /; and 2 more\. This cannot be undone\. Import\?$/.test(q17c), q17c);
    check('E17 a plan with renames only asks as before (no replaced rows)', he.importConfirmText({ renamed: 1, renames: [], adds: [] })
        === '1 name will change. This cannot be undone. Import?', '');
    const plain17 = he.planImport(parsedRows('host,alias\nnew01,X\n'), tableOf([outsideI]));
    check('E17 an add to a free key replaces nothing and asks nothing', plain17.replaced === 0 && plain17.added === 1
        && he.importConfirmText(plain17) === null && same(he.replaceLines(plain17), []), show(plain17));
    const full17 = he.planImport(parsedRows('host,alias\napp01,Short\n'), tableOf([outsideI], { storedCount: 5000, invalidCount: 4999 }));
    check('E17 a replacing line adds no row, so a full table takes it', full17.capacityError === null && full17.replaced === 1, show(full17));
    // A host whose own row is stored under a foreign key while ANOTHER host's row holds its derived key: the write to
    // that key replaces the other host's row, so it is counted as replaced, not as rekeyed, and adds no row.
    const ownForeign = ha.sanitizeAliasRow({ _key: 'X9', match_value: 'app01.example.com', alias: 'Web' });
    const holder17 = ha.sanitizeAliasRow({ _key: 'app01.example.com', match_value: 'db02.example.com', alias: 'DB two' });
    const both17 = he.planImport(parsedRows('host,alias\napp01.example.com,Web two\n'),
        tableOf([ownForeign, holder17], { storedCount: 5000, invalidCount: 4998 }));
    check('E17 an import write that both moves a host to its own key and replaces another host\'s row is counted as'
        + ' replaced, not rekeyed: no new row, so a full table takes it', both17.rekeyed === 0 && both17.replaced === 1
        && both17.renamed === 1 && both17.added === 0 && both17.toWrite.length === 1 && both17.toWrite[0]._key === 'app01.example.com'
        && both17.capacityError === null
        && same(he.replaceLines(both17), ['app01.example.com: Web two, replacing db02.example.com: DB two (key app01.example.com)']),
    show(both17));

    // E18 rows written outside this page that tie and give different names (KV-8): the dashboards show none.
    const x1 = ha.sanitizeAliasRow({ _key: 'X1', match_value: 'srv1', alias: 'Alpha' });
    const x2 = ha.sanitizeAliasRow({ _key: 'X2', match_value: 'SRV1', alias: 'Beta' });
    check('E18 conflictedKeys names a key whose tied rows give different names', same(Array.from(he.conflictedKeys([x1, x2])), ['srv1'])
        && ha.resolveAlias(ha.buildAliasIndex([x1, x2]), 'srv1') === null, show(Array.from(he.conflictedKeys([x1, x2]))));
    const x2same = ha.sanitizeAliasRow({ _key: 'X2', match_value: 'SRV1', alias: 'Alpha' });
    const x1own = ha.sanitizeAliasRow({ _key: 'srv1', match_value: 'srv1', alias: 'Alpha' });
    const x2later = ha.sanitizeAliasRow({ _key: 'X2', match_value: 'SRV1', alias: 'Beta', updated_at: 5 });
    const x1at = ha.sanitizeAliasRow({ _key: 'X1', match_value: 'srv1', alias: 'Alpha', updated_at: 5 });
    check('E18 no conflict for one name, a row under the derived key or a later write; a conflict on an equal time',
        he.conflictedKeys([x1, x2same]).size === 0 && he.conflictedKeys([x1own, x2]).size === 0
        && he.conflictedKeys([x1, x2later]).size === 0 && same(Array.from(he.conflictedKeys([x1at, x2later])), ['srv1'])
        && he.conflictedKeys([]).size === 0, '');
    const p18 = he.planImport(parsedRows('host,alias\nsrv1,Alpha\n'), tableOf([x1, x2]));
    check('E18 an import that names a conflicted host writes its own key and asks', p18.renamed === 1 && p18.unchanged === 0
        && p18.rekeyed === 1 && p18.toWrite.length === 1 && p18.toWrite[0]._key === 'srv1'
        && same(p18.renames, [{ host: 'srv1', oldAlias: '', newAlias: 'Alpha', conflictAliases: ['Alpha', 'Beta'] }])
        && same(he.renameLines(p18), ['srv1: no name (its rows give Alpha / Beta) -> Alpha'])
        && he.importConfirmText(p18) === '1 name will change. This cannot be undone. Import?', show(p18));
    const x1d = ha.sanitizeAliasRow({ _key: 'X1', match_value: 'srv1', alias: 'Alpha', description: 'from alpha' });
    const p18d = he.planImport(parsedRows('host,alias\nsrv1,Alpha\n'), tableOf([x2, x1d]));
    check('E18 on a conflict the description of the row that gives the file\'s name is kept', p18d.toWrite[0].description === 'from alpha',
        show(p18d.toWrite));
    const exp18 = ha.parseAliasCsv(ha.toAliasCsv(Array.from(he.effectiveRows([x1, x2]).values())));
    check('E18 after an export, re-importing a conflicted host is no "unchanged" line',
        he.planImport(exp18.rows, tableOf([x1, x2])).unchanged === 0, show(exp18));
    // Every order of a small list (the rows' read order: readAllKvRows asks for no sort).
    const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs.slice()]
        : xs.reduce((acc: T[][], x: T, i: number) => acc.concat(
            permutations(xs.slice(0, i).concat(xs.slice(i + 1))).map((rest) => [x].concat(rest))), []));
    // Three rows of one key: the two latest tie with different names, an older third gives another name. The conflict
    // lists the two tied names only, in every read order (tiedAliases keeps a row only while none outranks it).
    const x3old = ha.sanitizeAliasRow({ _key: 'X3', match_value: 'srv1', alias: 'Gamma', updated_at: 1 });
    const three = [x1at, x2later, x3old];
    const threeBad: string[] = [];
    permutations(three).forEach((rowsT) => {
        const pT = he.planImport(parsedRows('host,alias\nsrv1,Delta\n'), tableOf(rowsT));
        const sT = he.planSave(ha.sanitizeAliasRow({ match_value: 'srv1', alias: 'Delta' }), null, tableOf(rowsT));
        if (!same(pT.renames, [{ host: 'srv1', oldAlias: '', newAlias: 'Delta', conflictAliases: ['Alpha', 'Beta'] }])
            || !same(he.renameLines(pT), ['srv1: no name (its rows give Alpha / Beta) -> Delta'])
            || sT.kind !== 'write' || String(sT.confirmText).indexOf('(Alpha / Beta)') === -1) {
            threeBad.push(show([rowsT.map((x: any) => x.alias), pT.renames, sT]));
        }
    });
    check('E18 three rows, two tied latest and an older one: only the two tied names are listed, in every order',
        same(Array.from(he.conflictedKeys(three)), ['srv1']) && threeBad.length === 0, threeBad.join(' | '));
    // DOC-F2: the dashboards use none of a conflicted host's rows, but another entry can still name it - a short
    // entry covers its full names (rule c), full entries name their short value (rule d) - while the key stays flagged.
    const tiedFullA = ha.sanitizeAliasRow({ _key: 'F1', match_value: 'app01.example.com', alias: 'Name A' });
    const tiedFullB = ha.sanitizeAliasRow({ _key: 'F2', match_value: 'app01.example.com', alias: 'Name B' });
    const shortC = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'Short C' });
    const tiedShortA = ha.sanitizeAliasRow({ _key: 'S1', match_value: 'db01', alias: 'Name A' });
    const tiedShortB = ha.sanitizeAliasRow({ _key: 'S2', match_value: 'db01', alias: 'Name B' });
    const fullD = ha.sanitizeAliasRow({ match_value: 'db01.example.com', alias: 'Full D' });
    check('E18 a conflicted host shows no name of its own rows, yet another entry can still name it (the conflict texts'
        + ' say so)', ha.resolveAlias(ha.buildAliasIndex([tiedFullA, tiedFullB]), 'app01.example.com') === null
        && ha.resolveAlias(ha.buildAliasIndex([tiedFullA, tiedFullB, shortC]), 'app01.example.com') === 'Short C'
        && he.conflictedKeys([tiedFullA, tiedFullB, shortC]).has('app01.example.com')
        && ha.resolveAlias(ha.buildAliasIndex([tiedShortA, tiedShortB, fullD]), 'db01') === 'Full D'
        && he.conflictedKeys([tiedShortA, tiedShortB, fullD]).has('db01'), '');
    // N3: Save of a conflicted host names no one of the tied rows as its name ("already has the name"): it lists the
    // tied names, sorted, says the dashboards use none of them, and which rows stay.
    const R = (fields: { [k: string]: unknown }): any => ha.sanitizeAliasRow(fields);
    const t18 = tableOf([x2, x1]);
    const add18 = he.planSave(R({ match_value: 'srv1', alias: 'Gamma' }), null, t18);
    check('E18 Save of a conflicted host: the tied names, the dashboards use none of them, those rows stay (no "already has'
        + ' the name")', add18.kind === 'write' && add18.removeStoredKey === null && add18.confirmText === 'The host srv1 has rows'
        + ' written outside this page that give it different names (Alpha / Beta), so the dashboards use none of them. Saving'
        + ' writes the name "Gamma" under the host\'s own key, which the dashboards then use, while those rows stay. Save it?'
        && String(add18.confirmText).indexOf('already has the name') === -1, show(add18));
    const edit18 = he.planSave(R({ match_value: 'srv1', alias: 'Alpha' }), x1, t18);
    check('E18 the edit of one of its rows: "its other row stays", and that row is then removed', edit18.kind === 'write'
        && edit18.removeStoredKey === 'X1' && edit18.confirmText === 'The host srv1 has rows written outside this page that'
        + ' give it different names (Alpha / Beta), so the dashboards use none of them. Saving writes the name "Alpha" under'
        + ' the host\'s own key, which the dashboards then use, while its other row stays. Save it? The entry for srv1 is then'
        + ' removed.', show(edit18));
    const db07 = R({ _key: 'db07', match_value: 'db07', alias: 'DB' });
    const move18 = he.planSave(R({ match_value: 'srv1', alias: 'DB' }), db07, tableOf([x1, db07, x2]));
    check('E18 another host\'s row moved onto a conflicted host: "those rows stay", the moved entry then removed',
        move18.kind === 'write' && move18.removeStoredKey === 'db07' && move18.confirmText === 'The host srv1 has rows'
        + ' written outside this page that give it different names (Alpha / Beta), so the dashboards use none of them. Saving'
        + ' writes the name "DB" under the host\'s own key, which the dashboards then use, while those rows stay. Save it?'
        + ' The entry for db07 is then removed.', show(move18));
    const fullT18 = (rowsF: any[]): any => he.planSave(R({ match_value: 'srv1', alias: 'Gamma' }), null,
        tableOf(rowsF, { storedCount: 5000, invalidCount: 4998 }));
    check('E18 in a full table the refusal names the same row in either read order (the tied row under the smallest key)',
        fullT18([x1, x2]).kind === 'full' && same(fullT18([x1, x2]), fullT18([x2, x1])) && fullT18([x2, x1]).message
        === 'The table already holds 5,000 rows, the most it can hold. The host srv1 has a row written outside this page:'
            + ' saving writes the name under its own key, a new row, and the old one stays. Delete a row first.',
    show([fullT18([x1, x2]), fullT18([x2, x1])]));
    // A host that is not conflicted keeps the old question (E12), so only a conflict changes the text.
    check('E18 a host with one name in effect still asks "already has the name"', /^The host SRV1 already has the name "Beta"\./
        .test(String(he.planSave(R({ match_value: 'srv1', alias: 'Gamma' }), null, tableOf([x1, x2later])).confirmText)), '');

    // E19 the name a host value shows once a row is deleted (KV-10): another entry may still name it.
    const dbShort = ha.sanitizeAliasRow({ match_value: 'db01', alias: 'DB short' });
    const dbFull = ha.sanitizeAliasRow({ match_value: 'db01.example.com', alias: 'DB' });
    check('E19 a short entry deleted: the full entry still names the short host (rule d)',
        he.nameAfterDelete([dbShort, dbFull], dbShort) === 'DB', String(he.nameAfterDelete([dbShort, dbFull], dbShort)));
    const appShort = ha.sanitizeAliasRow({ match_value: 'app01', alias: 'App' });
    const appFull = ha.sanitizeAliasRow({ match_value: 'app01.example.com', alias: 'Payroll' });
    check('E19 a full entry deleted: the short entry still covers it (rule c)',
        he.nameAfterDelete([appShort, appFull], appFull) === 'App', String(he.nameAfterDelete([appShort, appFull], appFull)));
    const canon9 = ha.sanitizeAliasRow({ _key: 'app09', match_value: 'app09', alias: 'New' });
    const foreign9 = ha.sanitizeAliasRow({ _key: 'foreign-9', match_value: 'app09', alias: 'Old' });
    check('E19 another row of the same host takes over, either way round', he.nameAfterDelete([canon9, foreign9], canon9) === 'Old'
        && he.nameAfterDelete([canon9, foreign9], foreign9) === 'New', '');
    check('E19 a lone row: no name after', he.nameAfterDelete([dbShort], dbShort) === null, '');
    const xOwn = ha.sanitizeAliasRow({ _key: 'srv1', match_value: 'srv1', alias: 'Own' });
    check('E19 a conflict left behind: no name after', he.nameAfterDelete([xOwn, x1, x2], xOwn) === null, '');

    // E20 the host field's error names every rule isAliasableValue applies (D4), and no IP address (AppInspect).
    check('E20 NOT_A_HOST_TEXT names every rule', /without brackets or a zone id/.test(he.NOT_A_HOST_TEXT)
        && /starts with a letter, a digit or an underscore/.test(he.NOT_A_HOST_TEXT)
        && /only digits and dots must be an IPv4 address/.test(he.NOT_A_HOST_TEXT)
        && /letter or a digit in every part/.test(he.NOT_A_HOST_TEXT)
        && !/\d{1,3}(\.\d{1,3}){3}|[0-9A-Fa-f]*::[0-9A-Fa-f]/.test(he.NOT_A_HOST_TEXT), he.NOT_A_HOST_TEXT);
    check('E20 the values it names are refused as it says', he.checkForm('[2001:db8::1]', 'X', '').host === he.NOT_A_HOST_TEXT
        && he.checkForm('fe80::1%eth0', 'X', '').host === he.NOT_A_HOST_TEXT && he.checkForm('-app01', 'X', '').host === he.NOT_A_HOST_TEXT
        && he.checkForm('1.2.3.256', 'X', '').host === he.NOT_A_HOST_TEXT && he.checkForm('app01._', 'X', '').host === he.NOT_A_HOST_TEXT
        && he.checkForm('_svc.example.com', 'X', '').host === null, '');

    // E22 the editor's choices do not depend on the order the rows were read in (N3: readAllKvRows asks for no sort).
    // ranksBefore orders the rows of one key - the dashboards' order (winsOver) first, then the smaller stored key -
    // and effectiveRows keeps the first and lists the keys in code-unit order, so every plan, question and the export
    // are the same for the same rows in any order; Save and Import compare plans as JSON (KV-3), so a re-read in
    // another order stops nothing.
    const own22 = R({ _key: 'app01', match_value: 'app01', alias: 'Own', updated_at: 1 });
    const later22 = R({ _key: 'f2', match_value: 'app01', alias: 'Later', updated_at: 9 });
    const earlier22 = R({ _key: 'f1', match_value: 'app01', alias: 'Earlier', updated_at: 3 });
    const k0 = R({ _key: 'k0', match_value: 'app01', alias: 'A', description: 'dA0', updated_at: 5 });
    const k1 = R({ _key: 'k1', match_value: 'app01', alias: 'A', description: 'dA', updated_at: 5 });
    const k2 = R({ _key: 'k2', match_value: 'APP01', alias: 'B', description: 'dB', updated_at: 5 });
    const k9 = R({ _key: 'k9', match_value: 'app01', alias: 'C', description: 'dC', updated_at: 1 });
    const web22 = R({ _key: 'web01', match_value: 'web01', alias: 'Web' });
    check('E22 ranksBefore: the row under its own key before a later foreign write, then the later write, then the smaller'
        + ' stored key; never a row before itself', he.ranksBefore(own22, later22) && !he.ranksBefore(later22, own22)
        && he.ranksBefore(later22, earlier22) && !he.ranksBefore(earlier22, later22) && he.ranksBefore(k0, k1)
        && !he.ranksBefore(k1, k0) && he.ranksBefore(k1, k2) && !he.ranksBefore(k0, k0) && !he.ranksBefore(own22, own22)
        && he.ranksBefore(k2, k9) && !he.ranksBefore(k9, k0), '');
    // Past the stored key (rows the KV Store cannot hold twice, so only the documented order): the host value, the
    // name, the description and updated_by, each in plain code-unit order.
    const sk = (extra: { [k: string]: unknown }): any => ({ _key: 'app01', match_value: 'app01', alias: 'A', stored_key: 'f', ...extra });
    const chain22 = [sk({ match_value: 'APP01' }), sk({}), sk({ alias: 'B' }), sk({ alias: 'B', description: 'd' }),
        sk({ alias: 'B', description: 'd', updated_by: 'u' })];
    const chainBad: string[] = [];
    chain22.forEach((a, i) => chain22.forEach((b, j) => {
        if (he.ranksBefore(a, b) !== (i < j)) {
            chainBad.push(`${i} before ${j}: ${he.ranksBefore(a, b)}`);
        }
    }));
    check('E22 ranksBefore past the stored key: host value, name, description, updated_by', chainBad.length === 0, chainBad.join('; '));
    // The 5-row table: app01 has three tied foreign rows (k0 and k1 "A", k2 "B") and an older one (k9 "C"), so it is
    // conflicted; web01 is plain. All 120 read orders give one result each.
    const base22 = [k1, k2, k0, k9, web22];
    const sigOf = (rowsS: any[]): any => {
        const tS = tableOf(rowsS);
        const eff = he.effectiveRows(rowsS);
        const impA = he.planImport(parsedRows('host,alias\napp01,A\n'), tS);
        const impZ = he.planImport(parsedRows('host,alias\napp01,Z\n'), tS);
        return {
            entries: Array.from(eff.entries()),
            csv: ha.toAliasCsv(Array.from(eff.values())),
            addC: he.planSave(R({ match_value: 'app01', alias: 'C' }), null, tS),
            editK1: he.planSave(R({ match_value: 'app01', alias: 'A' }), k1, tS),
            impA,
            impZ,
            qA: he.importConfirmText(impA),
            qZ: he.importConfirmText(impZ),
        };
    };
    const sigs22 = permutations(base22).map((p) => show(sigOf(p)));
    const first22 = sigOf(base22);
    check('E22 all 120 read orders of the table give the same row in effect, export, Save plans, Import plans and questions',
        sigs22.length === 120 && sigs22.every((s) => s === sigs22[0]), `${new Set(sigs22).size} distinct results`);
    check('E22 the row in effect is the tied row under the smallest key (k0), and the keys come in code-unit order',
        same(first22.entries.map((e: any) => e[0]), ['app01', 'web01']) && first22.entries[0][1].stored_key === 'k0'
        && same(Array.from(he.effectiveRows([web22, k9, k2, k1, k0]).keys()), ['app01', 'web01']), show(first22.entries));
    check('E22 Save of the conflicted host: the tied names A / B, the description of k0 kept', first22.addC.kind === 'write'
        && first22.addC.row.description === 'dA0' && first22.addC.removeStoredKey === null && first22.addC.confirmText
        === 'The host app01 has rows written outside this page that give it different names (A / B), so the dashboards use'
            + ' none of them. Saving writes the name "C" under the host\'s own key, which the dashboards then use, while those'
            + ' rows stay. Save it?', show(first22.addC));
    check('E22 the edit of k1: "its other rows stay", k1 then removed, k0\'s description kept', first22.editK1.kind === 'write'
        && first22.editK1.removeStoredKey === 'k1' && first22.editK1.row.description === 'dA0'
        && /, while its other rows stay\. Save it\? The entry for app01 is then removed\.$/.test(String(first22.editK1.confirmText)),
    show(first22.editK1));
    check('E22 Import of the conflicted host keeps the description of k0 (a row that gives the file\'s name, else the row in'
        + ' effect)', first22.impA.toWrite.length === 1 && first22.impA.toWrite[0].description === 'dA0'
        && first22.impZ.toWrite.length === 1 && first22.impZ.toWrite[0].description === 'dA0'
        && first22.qA === '1 name will change. This cannot be undone. Import?', show([first22.impA, first22.impZ]));
    // A sweep over random tables (own, foreign and displacing rows, ties with and without updated_at, conflicts): each
    // table in several shuffled orders gives the same plans, questions, row in effect, export and conflicted keys.
    let seed22 = 2201;
    const rnd22 = (n: number): number => {
        seed22 = (seed22 * 1103515245 + 12345) % 2147483648;
        return Math.floor(seed22 / 65536) % n;
    };
    const shuffled = (xs: any[]): any[] => {
        const out = xs.slice();
        for (let i = out.length - 1; i > 0; i -= 1) {
            const j = rnd22(i + 1);
            const tmp = out[i];
            out[i] = out[j];
            out[j] = tmp;
        }
        return out;
    };
    const HOSTS22 = ['app01', 'app01.example.com', 'db01', 'web01'];
    const NAMES22 = ['A', 'B', 'C'];
    let tablesConflicted = 0;
    let questionsConflicted = 0;
    let orders22 = 0;
    let bad22 = '';
    for (let n = 0; n < 80 && bad22 === ''; n += 1) {
        const used = new Set<string>();
        const rowsN: any[] = [];
        HOSTS22.forEach((h, hi) => {
            const count = rnd22(4);
            for (let j = 0; j < count; j += 1) {
                const pick = rnd22(6);
                let storedAs = `f${hi}${j}`;
                if (pick === 0 && !used.has(h)) {
                    storedAs = h;
                } else if (pick === 1) {
                    storedAs = HOSTS22[rnd22(HOSTS22.length)];
                }
                if (!used.has(storedAs)) {
                    used.add(storedAs);
                    const fields: { [k: string]: unknown } = { _key: storedAs, match_value: rnd22(2) ? h.toUpperCase() : h,
                        alias: NAMES22[rnd22(3)] };
                    const desc = ['', 'd1', 'd2'][rnd22(3)];
                    if (desc !== '') {
                        fields.description = desc;
                    }
                    const at = rnd22(3);
                    if (at > 0) {
                        fields.updated_at = at;
                    }
                    rowsN.push(R(fields));
                }
            }
        });
        const forms = HOSTS22.map((h) => R({ match_value: h, alias: NAMES22[rnd22(3)] }));
        const edits = rowsN.map((x: any) => [x, R({ match_value: HOSTS22[rnd22(HOSTS22.length)], alias: NAMES22[rnd22(3)] })]);
        const csvN = parsedRows(`host,alias,description\n${HOSTS22[rnd22(2)]},${NAMES22[rnd22(3)]},\n`
            + `${HOSTS22[2 + rnd22(2)]},Z,${rnd22(2) ? 'd9' : ''}\n`);
        const sigN = (rowsS: any[]): string => {
            const tS = tableOf(rowsS);
            const eff = he.effectiveRows(rowsS);
            const imp = he.planImport(csvN, tS);
            return show({
                entries: Array.from(eff.entries()),
                csv: ha.toAliasCsv(Array.from(eff.values())),
                conflicted: Array.from(he.conflictedKeys(rowsS)).sort(),
                saves: forms.map((f) => he.planSave(f, null, tS)),
                edits: edits.map(([ed, f]) => he.planSave(f, ed, tS)),
                imp,
                question: he.importConfirmText(imp),
            });
        };
        const want = sigN(rowsN);
        if (he.conflictedKeys(rowsN).size > 0) {
            tablesConflicted += 1;
        }
        if (want.indexOf('give it different names') !== -1) {
            questionsConflicted += 1;
        }
        for (let s = 0; s < 6 && bad22 === ''; s += 1) {
            const order22 = shuffled(rowsN);
            orders22 += 1;
            if (sigN(order22) !== want) {
                bad22 = `${show(rowsN)} in the order ${show(order22.map((x: any) => he.storedKeyOf(x)))}`;
            }
        }
    }
    check('E22 random tables in shuffled orders: the same plans, questions, export and conflicted keys (a sweep that meets'
        + ' conflicts)', bad22 === '' && orders22 === 480 && tablesConflicted >= 10 && questionsConflicted >= 5, bad22
        || `${orders22} orders, ${tablesConflicted} conflicted tables, ${questionsConflicted} with a conflict question`);

    // E15 the module stays pure, and the editor component keeps none of this logic itself.
    const editorSrc = read(path.join(HOME, 'utils/hostAliasEditor.ts'));
    const editorCode = editorSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const imports = editorCode.match(/^import[\s\S]*?from '([^']+)';/gm) || [];
    check('E15 hostAliasEditor.ts imports only ./hostAlias (gate-safe: no React, no network, no DOM)',
        imports.length === 1 && /from '\.\/hostAlias';$/.test(imports[0]) && !/\brequire\(/.test(editorCode)
        && !/\bReact\b|\bfetch\s*\(|\bdocument\.|\bwindow\.|XMLHttpRequest|localStorage|sessionStorage/.test(editorCode),
        show(imports));
    const panelSrc = read(path.join(HOME, 'components/HostAliasPanel.tsx'));
    const ownCopiesE = ['winsOver', 'ranksBefore', 'effectiveRows', 'checkForm', 'planImport', 'planSave', 'describeFailure', 'listRows',
        'textProblem', 'conflictedKeys', 'tiedAliases', 'nameAfterDelete', 'replaceLines', 'renameLines', 'addLines', 'importConfirmText',
        'storedKeyOf', 'keyOf', 'isoOfEpoch', 'isDeletableKey'].filter((nm) => new RegExp(`\\bconst ${nm}\\s*=`).test(panelSrc));
    check('E15 the editor component defines none of the decisions itself', ownCopiesE.length === 0, show(ownCopiesE));
    check('E15 the editor plans Import over the table with its stored counts', /const table = useMemo<TableState>\(\s*\(\) => \(\{ rows, complete, storedCount, invalidCount \}\),/
        .test(panelSrc) && /planImport\(parsed\.rows, table\)/.test(panelSrc) && /planSave\(row, editing, table\)/.test(panelSrc)
        && /setStoredCount\(read\.storedCount\);\s*setInvalidCount\(read\.invalidCount\);/.test(panelSrc), 'table / planImport / planSave');
    check('E15 Import asks before it changes a name (as Delete asks)', /const question = importConfirmText\(plan\);\s*\/\/ eslint-disable-next-line no-alert\s*if \(question !== null && !window\.confirm\(question\)\) \{\s*return;\s*\}\s*const \{ toWrite \} = plan;/
        .test(panelSrc), 'importConfirmText -> window.confirm before the write');
    check('E15 the count line names the rows that cannot be shown', /countLineText\(table\)/.test(panelSrc), 'countLineText(table)');
    // E23 (build 403) the list's header and its rows are separate grids on one track list, so each track must be the
    // same width in both: no content-sized track (auto, min-content, max-content, fit-content), and the Edit / Delete
    // column a fixed px width. As `auto` (builds 400-402) it was 0 px in the empty header cell and as wide as the Edit and
    // Delete buttons in a row, and every heading after Name sat right of its column. Six header cells and six cells a row.
    const rowColsM = /\nconst ACTIONS_COL = '(\d+)px';\nconst ROW_COLS =\s*`([^`]*)`;/.exec(panelSrc);
    const rowTracks: string[] = rowColsM
        ? (rowColsM[2].split('${ACTIONS_COL}').join(`${rowColsM[1]}px`).match(/minmax\([^)]*\)|\S+/g) || []) : [];
    const listJsx = panelSrc.slice(panelSrc.indexOf('<TableHead role="row">'), panelSrc.indexOf('</RowActions>'));
    // The horizontal spacing of the two grids: the one gap line, and the padding line (whose second value, the sides,
    // must be 0); any other spacing property (column-gap, padding-left / -right, margin) counts against the check.
    // Build 406: the declarations are read by splitting the block on ';' (interpolations kept, comments and nested
    // rules taken out first), not by matching the start of a line: a second declaration on a line, or one after an
    // interpolation, is seen too. Every property that changes where a track starts or how wide the grid is counts:
    // gap, padding, margin, a side or all-round border, width, box-sizing, justify-*.
    const HORIZONTAL = new RegExp('^(gap|column-gap|row-gap|grid-gap|grid-column-gap|padding|padding-left|padding-right'
        + '|padding-inline[-a-z]*|margin[-a-z]*|border|border-width|border-style|border-left[-a-z]*|border-right[-a-z]*'
        + '|border-inline[-a-z]*|width|min-width|max-width|inline-size|box-sizing|justify-content|justify-items)$');
    const topDecls = (css: string): string[] => {
        const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const mask = (t: string): string => t.replace(/\$\{[^}]*\}/g, (m0: string) => 'X'.repeat(m0.length));
        // nested rules out (their braces found on the text with the interpolations masked)
        let top = '';
        let depth = 0;
        const masked = mask(noComments);
        for (let i = 0; i < noComments.length; i += 1) {
            if (masked[i] === '{') {
                depth += 1;
                // drop the selector that opened this rule
                top = top.slice(0, top.lastIndexOf(';') + 1);
            } else if (masked[i] === '}') {
                depth -= 1;
            } else if (depth === 0) {
                top += noComments[i];
            }
        }
        return top.split(';').map((d: string) => d.replace(/\s+/g, ' ').trim()).filter((d: string) => d !== '');
    };
    const headRowSpacing = (comp: string): string[] => {
        const m = new RegExp(`const ${comp} = styled\\.div(?:<[^>]*>)?\`([^\`]*)\``).exec(panelSrc);
        const css = m ? m[1] : '';
        const decls = topDecls(css);
        const lines = decls.filter((d: string) => !/^[-a-z]+\s*:\s*\S/.test(d) || HORIZONTAL.test(d.replace(/\s*:[\s\S]*$/, '')))
            .map((d: string) => d.replace(/\s*:\s*/, ': '));
        const gap = lines.filter((l: string) => /^gap:/.test(l));
        const pad = lines.filter((l: string) => /^padding:/.test(l)).map((l: string) => l.replace(/^padding:\s*/, ''));
        return lines.length === 2 && gap.length === 1 && pad.length === 1 ? [gap[0], pad[0]] : lines;
    };
    check('E23 the Host Names list: the header and every row use one track list whose tracks size the same in both'
        + ' (no auto or content-sized track; the Edit / Delete column a fixed width of at least 110 px)',
        rowColsM !== null && Number(rowColsM[1]) >= 110 && rowTracks.length === 6
        && rowTracks.every((t: string) => !/\b(auto|min-content|max-content|fit-content)\b/.test(t))
        && rowTracks[5] === `${rowColsM[1]}px`
        && /const TableHead = styled\.div`\s*display: grid;\s*grid-template-columns: \$\{ROW_COLS\};/.test(panelSrc)
        && /const TableRow = styled\.div<\{ \$editing: boolean \}>`\s*display: grid;\s*grid-template-columns: \$\{ROW_COLS\};/
            .test(panelSrc)
        && (panelSrc.match(/\$\{ROW_COLS\}/g) || []).length === 2
        && (listJsx.match(/role="columnheader"/g) || []).length === 6
        && (listJsx.match(/role="cell"/g) || []).length === 6
        && headRowSpacing('TableHead').length === 2 && headRowSpacing('TableRow').length === 2
        && headRowSpacing('TableHead')[0] === headRowSpacing('TableRow')[0] && headRowSpacing('TableHead')[0] === 'gap: ${logservTheme.spacing.md}'
        && /\S+ 0$/.test(headRowSpacing('TableHead')[1]) && /\S+ 0$/.test(headRowSpacing('TableRow')[1]),
        `ACTIONS_COL / ROW_COLS: ${rowColsM ? rowColsM[0] : 'not found'}; tracks ${show(rowTracks)}; spacing ${show(headRowSpacing('TableHead'))} / ${show(headRowSpacing('TableRow'))}`);
    check('E23 the reader sees a declaration wherever it sits: a second one on a line, one after an interpolation, a'
        + ' side border, a width; and not a nested rule\'s',
        show(topDecls('a: 1; gap: 2px;\n  color: ${x}; padding-left: 3px;\n  &:last-child {\n  margin: 0;\n }\n width : 5px')) === show(
            ['a: 1', 'gap: 2px', 'color: ${x}', 'padding-left: 3px', 'width : 5px'])
        && ['gap', 'padding-left', 'padding-inline-start', 'margin-right', 'border', 'border-left', 'border-left-width', 'width', 'box-sizing']
            .every((p: string) => HORIZONTAL.test(p))
        && ['border-bottom', 'border-top', 'border-radius', 'color', 'background', 'font-size', 'align-items', 'padding-top', 'height']
            .every((p: string) => !HORIZONTAL.test(p)),
        show(topDecls('a: 1; gap: 2px;\n  color: ${x}; padding-left: 3px;\n  &:last-child {\n  margin: 0;\n }\n width : 5px')));
    // E16 the read reports the stored rows and the refused ones (hostAliasApi loads @splunk modules, so pinned in source).
    const apiSrc = read(path.join(HOME, 'utils/hostAliasApi.ts'));
    check('E16 readAllHostAliases counts every stored row read, and the ones sanitizeAliasRow refuses',
        /const stored = read\.rows\.slice\(0, MAX_ROWS\);/.test(apiSrc)
        && /stored\.forEach\(\(row\) => \{\s*const clean = sanitizeAliasRow\(row\);\s*if \(clean !== null\) \{\s*rows\.push\(clean\);\s*\} else \{\s*invalidCount \+= 1;\s*\}\s*\}\);/
            .test(apiSrc) && /storedCount: stored\.length,\s*invalidCount,/.test(apiSrc)
        && /complete: read\.complete && read\.rows\.length <= MAX_ROWS,/.test(apiSrc), 'stored / invalidCount / storedCount');
    check('E15 the preview lists the names that change and the hosts to add', /firstLines\(plan !== null \? renameLines\(plan\) : \[\]\)/
        .test(panelSrc) && /firstLines\(plan !== null \? addLines\(plan\) : \[\]\)/.test(panelSrc), 'renameLines / addLines');
    check('E15 the two lists show only while no line is refused',
        /\{parsed\.errors\.length === 0 && renamedList\.lines\.length > 0 && \(/.test(panelSrc)
        && /\{parsed\.errors\.length === 0 && addedList\.lines\.length > 0 && \(/.test(panelSrc)
        && (panelSrc.match(/\{renamedList\.lines\.map\(/g) || []).length === 1
        && (panelSrc.match(/\{addedList\.lines\.map\(/g) || []).length === 1, 'parsed.errors.length === 0 && ...List.lines.length > 0');
    check('E15 the tip shows only while Import is on (not beside refused lines, a capacity error or nothing to write)',
        /\{!importBlocked && <Hint>Tip: Export CSV first to keep a copy\.<\/Hint>\}/.test(panelSrc)
        && panelSrc.split('Tip: Export CSV first').length === 2, '{!importBlocked && <Hint>Tip: ...</Hint>}');
    check('E15 the import hint says the preview lists the lines it refuses (not every line: it shows the first 100)',
        /Preview lists the lines it\s+refuses;/.test(panelSrc) && !/Preview lists every\s+line/.test(panelSrc),
        'Preview lists the lines it refuses');
    // AppInspect's check_hostnames_and_ips reads the built bundle, where the editor's strings land: no address
    // in its examples (the host field's placeholder, the paste box's sample CSV), nor anywhere in the file.
    const panelIps = panelSrc.match(/(^|[^\d.])\d{1,3}(\.\d{1,3}){3}(?![\d.]*\d)|[0-9A-Fa-f]*::[0-9A-Fa-f]/g) || [];
    check('E15 the editor names no IP address (AppInspect reads the bundle its examples ship in)', panelIps.length === 0
        && /placeholder="app01\.example\.com, app01 or an IP address"/.test(panelSrc), show(panelIps));
    check('E15 the dashboards\' read-error banner shows only when the editor\'s read and the provider\'s are both done',
        /\{loadError === null && !loading && dashboardsError !== null && !dashboardsLoading && \(/.test(panelSrc)
        && /const \{ reload, error: dashboardsError, loading: dashboardsLoading \} = useHostAliasStatus\(\);/.test(panelSrc),
        'loadError === null && !loading && dashboardsError !== null && !dashboardsLoading');

    // E21 the editor's write paths (T1): what each one sends is the plan's, never a list of its own. The handlers are
    // cut out of the source by name, so a pin cannot match the other handler's code.
    const handlerOf = (name: string): string => {
        const start = panelSrc.indexOf(`const ${name} = async (`);
        const next = start === -1 ? -1 : panelSrc.indexOf('\n    };\n', start);
        return start === -1 || next === -1 ? '' : panelSrc.slice(start, next + 7);
    };
    const saveSrc = handlerOf('handleSave');
    const deleteSrc = handlerOf('handleDelete');
    const importSrc = handlerOf('handleImport');
    check('E21 the three write handlers are found', saveSrc !== '' && deleteSrc !== '' && importSrc !== '',
        show([saveSrc.length, deleteSrc.length, importSrc.length]));
    check('E21 Export writes the row in effect of each host (the import format, read back unchanged), with a byte order mark'
        + ' first (KV-9)', /const csv = toAliasCsv\(Array\.from\(effectiveRows\(rows\)\.values\(\)\)\);/.test(panelSrc)
        && /triggerDownload\(new Blob\(\[EXPORT_BOM, csv\], \{ type: 'text\/csv;charset=utf-8' \}\), EXPORT_FILE\);/.test(panelSrc)
        && /\nconst EXPORT_BOM = '\\uFEFF';\n/.test(panelSrc) && (panelSrc.match(/\btoAliasCsv\(/g) || []).length === 1
        && panelSrc.indexOf(ch(0xfeff)) === -1, 'toAliasCsv(Array.from(effectiveRows(rows).values())) and Blob([EXPORT_BOM, csv])');
    const upserts = panelSrc.match(/\bupsertHostAliases\([^)]*\)/g) || [];
    const deletes = panelSrc.match(/\bdeleteHostAlias\([^)]*\)/g) || [];
    check('E21 the writes: Save writes the plan\'s row, Import the plan\'s rows; nothing else is upserted',
        same(upserts, ['upsertHostAliases([toSave])', 'upsertHostAliases(toWrite)'])
        && /const \{ removeStoredKey, row: toSave \} = savePlan;/.test(saveSrc) && /const \{ toWrite \} = plan;/.test(importSrc)
        && saveSrc.indexOf('upsertHostAliases([toSave])') !== -1 && importSrc.indexOf('upsertHostAliases(toWrite)') !== -1,
    show(upserts));
    check('E21 the deletes: Delete removes the row by the key it is stored under, Save only the edited row it moved',
        same(deletes, ['deleteHostAlias(removeStoredKey)', 'deleteHostAlias(storedKey)'])
        && /const storedKey = storedKeyOf\(row\);/.test(deleteSrc) && deleteSrc.indexOf('await deleteHostAlias(storedKey);') !== -1
        && saveSrc.indexOf('await deleteHostAlias(removeStoredKey);') !== -1
        && /if \(editing !== null && removeStoredKey !== null\) \{\s*if \(isDeletableKey\(removeStoredKey\)\) \{/.test(saveSrc),
    show(deletes));
    check('E21 an edit that moves a row writes the new row before it deletes the old one (the host never has no name)',
        saveSrc.indexOf('upsertHostAliases([toSave])') !== -1
        && saveSrc.indexOf('upsertHostAliases([toSave])') < saveSrc.indexOf('deleteHostAlias(removeStoredKey)')
        && /if \(result\.failures\.length > 0\) \{\s*setOpError\([^;]*\);\s*return;\s*\}\s*let leftOver/.test(saveSrc),
    'upsertHostAliases([toSave]) first; a failed write returns before any delete');
    // KV-3: Save and Import read the table again right before the write, plan again over it, and write only when that plan
    // is the one the page showed and asked about. Order: the question, the read, the new plan, the comparison, the write.
    const order = (src: string, marks: string[]): number[] => marks.map((m) => src.indexOf(m));
    const ascending = (xs: number[]): boolean => xs.every((x, i) => x !== -1 && (i === 0 || x > xs[i - 1]));
    const saveOrder = order(saveSrc, ['const savePlan = planSave(row, editing, table);', '!window.confirm(savePlan.confirmText)',
        'fresh = await readAllHostAliases();', 'const editedNow = fresh.rows.find((r) => storedKeyOf(r) === editedKey);',
        'const freshPlan = planSave(row, editing, fresh);', 'if (planText(freshPlan) !== planText(savePlan)) {',
        'await upsertHostAliases([toSave]);']);
    check('E21 Save: confirm, read again, check the edited row, plan again, compare, then write (KV-3)', ascending(saveOrder),
        show(saveOrder));
    check('E21 Save writes nothing when the read fails, the edited row changed or the plan differs',
        /fresh = await readAllHostAliases\(\);\s*\} catch \(e\) \{[^}]*Nothing was saved: the host name table could not be read again[\s\S]*?return;\s*\}/
            .test(saveSrc)
        && /if \(editedNow === undefined \|\| !sameEntry\(editedNow, editing\)\) \{[\s\S]*?applyRead\(fresh\);[\s\S]*?return;\s*\}\s*\}\s*const freshPlan/
            .test(saveSrc)
        && /if \(planText\(freshPlan\) !== planText\(savePlan\)\) \{[\s\S]*?applyRead\(fresh\);[\s\S]*?return;\s*\}\s*try \{\s*const result = await upsertHostAliases\(\[toSave\]\);/
            .test(saveSrc), 'each stop path returns before the try that writes');
    const importOrder = order(importSrc, ['const question = importConfirmText(plan);', '!window.confirm(question)',
        'const { toWrite } = plan;', 'fresh = await readAllHostAliases();', 'const freshPlan = planImport(parsed.rows, fresh);',
        'if (planText(freshPlan) !== planText(plan) || importConfirmText(freshPlan) !== question) {',
        'await upsertHostAliases(toWrite);']);
    check('E21 Import: confirm, read again, plan the file again, compare plan and question, then write (KV-3)',
        ascending(importOrder), show(importOrder));
    check('E21 Import writes nothing when the read fails or the plan differs',
        /fresh = await readAllHostAliases\(\);\s*\} catch \(e\) \{[^}]*The import did not run: the host name table could not be read again[\s\S]*?return;\s*\}/
            .test(importSrc)
        && /\|\| importConfirmText\(freshPlan\) !== question\) \{[\s\S]*?applyRead\(fresh\);[\s\S]*?return;\s*\}\s*try \{\s*const result = await upsertHostAliases\(toWrite\);/
            .test(importSrc), 'each stop path returns before the try that writes');
    check('E21 a plan is compared whole, as JSON, and an entry by host value, name and description',
        /\nconst planText = \(plan: unknown\): string => JSON\.stringify\(plan\);\n/.test(panelSrc)
        && /\nconst sameEntry = \(a: HostAliasRow, b: HostAliasRow\): boolean =>\s*a\.match_value === b\.match_value && a\.alias === b\.alias && \(a\.description \|\| ''\) === \(b\.description \|\| ''\);\n/
            .test(panelSrc), 'planText / sameEntry');
    check('E21 the list is read again on the nav-bar Refresh and when the dashboards\' copy is read from elsewhere',
        /const \{ globalRefreshNonce \} = useGlobalRefresh\(\);/.test(panelSrc)
        && /if \(seenNonceRef\.current === globalRefreshNonce\) \{\s*return;\s*\}\s*seenNonceRef\.current = globalRefreshNonce;\s*load\(\);\s*\}, \[globalRefreshNonce, load\]\);/
            .test(panelSrc)
        && /const started = dashboardsLoading && !providerLoadingRef\.current;\s*providerLoadingRef\.current = dashboardsLoading;\s*if \(started && !readingRef\.current\) \{\s*load\(\);\s*\}\s*\}, \[dashboardsLoading, load\]\);/
            .test(panelSrc), 'the nonce effect and the provider-loading effect');
    // KV-10: Delete says what the host value then shows, and that the change shows at once in this tab.
    check('E21 Delete asks with the name the host value shows once the row is gone (KV-10)',
        /const after = nameAfterDelete\(rows, row\);/.test(deleteSrc) && /window\.confirm\(deleteQuestion\(row, after\)\)/.test(deleteSrc)
        && deleteSrc.indexOf('const after = nameAfterDelete(rows, row);') < deleteSrc.indexOf('await deleteHostAlias(storedKey);')
        && /\nconst deleteQuestion = \(row: HostAliasRow, after: string \| null\): string =>\s*`Delete the name "\$\{row\.alias\}" for \$\{row\.match_value\}\? On the dashboards, \$\{row\.match_value\} then shows ` \+\s*`\$\{after !== null \? `as "\$\{after\}"` : 'without a name'\}: at once in this browser tab, and in other open ` \+\s*'tabs after their next Refresh\. This cannot be undone\.';/
            .test(panelSrc)
        && !/from their next refresh/i.test(panelSrc), 'deleteQuestion(row, nameAfterDelete(rows, row))');
    // SEC-1: the Updated cell's title goes through isoOfEpoch, which never throws; no toISOString in the editor.
    check('E21 the Updated cell\'s title is isoOfEpoch(row.updated_at) (SEC-1)', /title=\{isoOfEpoch\(row\.updated_at\) \|\| ''\}/.test(panelSrc)
        && panelSrc.indexOf('toISOString') === -1, 'title={isoOfEpoch(row.updated_at) || \'\'}');
    // KV-11, KV-12: no "0 of 5,000" after a failed read; a header-only file says it holds no rows.
    check('E21 after a failed read the count is unknown (KV-11)', /\} else if \(loadError !== null\) \{\s*countText = `unknown of \$\{fmtCount\(MAX_ROWS\)\}`;\s*\}/
        .test(panelSrc), 'countText = unknown of 5,000 while loadError is set');
    check('E21 a file with no rows below its header says so, and is not "already has these names" (KV-12)',
        /\{parsed\.errors\.length === 0 && parsed\.rows\.length === 0 && \(\s*<Hint>The file holds no rows below the header\.<\/Hint>\s*\)\}/
            .test(panelSrc)
        && /\{parsed\.errors\.length === 0 &&\s*parsed\.rows\.length > 0 &&\s*plan\.capacityError === null &&\s*plan\.toWrite\.length === 0 && \(\s*<Hint>Every host in the file already has these names/
            .test(panelSrc), 'the header-only hint and the parsed.rows.length > 0 guard');
    // KV-8: the rows of a conflicted host are marked.
    check('E21 the rows of a host whose rows conflict are marked (KV-8)', /const conflicted = useMemo\(\(\) => conflictedKeys\(rows\), \[rows\]\);/
        .test(panelSrc) && /\{conflicted\.has\(keyOf\(row\)\) && \(\s*<ConflictNote title=\{CONFLICT_TEXT\}>\{CONFLICT_NOTE\}<\/ConflictNote>\s*\)\}/
        .test(panelSrc), 'conflicted.has(keyOf(row)) && <ConflictNote ...>');
    // KV-2: the preview counts and lists the rows of other hosts an import replaces, only while no line is refused.
    check('E21 the preview counts and lists the rows of other hosts the import replaces (KV-2)',
        /const replacedList = firstLines\(plan !== null \? replaceLines\(plan\) : \[\]\);/.test(panelSrc)
        && /\{plan\.replaced > 0 && \(\s*<span>\s*Rows of other hosts replaced: <CountValue>\{fmtCount\(plan\.replaced\)\}<\/CountValue>/.test(panelSrc)
        && /\{parsed\.errors\.length === 0 && replacedList\.lines\.length > 0 && \(/.test(panelSrc)
        && (panelSrc.match(/\{replacedList\.lines\.map\(/g) || []).length === 1, 'replacedList / plan.replaced');
    // D3: the row that cannot be deleted says every reason isDeletableKey refuses its key.
    const ndM = /\nconst NOT_DELETABLE_TEXT =\s*((?:'[^'\n]*'\s*\+?\s*)+);/.exec(panelSrc);
    const notDeletable = ndM ? (ndM[1].match(/'([^'\n]*)'/g) || []).map((s: string) => s.slice(1, -1)).join('') : '';
    const ND_REASONS = ['a slash', 'a backslash', 'a percent sign', 'a question mark', 'a number sign', 'a semicolon', 'control',
        'direction', 'invisible', 'only dots or blanks', '1,024'];
    check('E21 NOT_DELETABLE_TEXT names every reason a key cannot be deleted (D3)', notDeletable !== ''
        && ND_REASONS.every((w) => notDeletable.indexOf(w) !== -1) && !/\bempty\b/.test(notDeletable),
    `missing: ${show(ND_REASONS.filter((w) => notDeletable.indexOf(w) === -1))} in ${show(notDeletable)}`);
    // N1: after a stop because the edited row changed, the form edits that row as read now, so the next Save compares
    // with it (keeping the stale row would stop every later Save until Cancel); it is handleSave's only setEditing.
    const stopAt = saveSrc.indexOf('if (editedNow === undefined || !sameEntry(editedNow, editing)) {');
    const setAt = saveSrc.indexOf('setEditing(editedNow !== undefined ? editedNow : null);');
    check('E21 Save\'s edited-row stop edits the row as read now (setEditing(editedNow), not the stale row)', stopAt !== -1
        && setAt > stopAt && setAt < saveSrc.indexOf('const freshPlan = planSave(row, editing, fresh);')
        && (saveSrc.match(/\bsetEditing\(/g) || []).length === 1, show([stopAt, setAt]));
    // N1: load() marks itself reading before its await, so the provider-loading effect starts no second read.
    const loadAt = panelSrc.indexOf('const load = useCallback(async (): Promise<void> => {');
    const loadSrc = loadAt === -1 ? '' : panelSrc.slice(loadAt, panelSrc.indexOf('}, [applyRead]);', loadAt));
    check('E21 load() sets readingRef before it reads and clears it on both outcomes; nothing else sets it',
        ascending(order(loadSrc, ['readingRef.current = true;', 'await readAllHostAliases(', 'readingRef.current = false;']))
        && (loadSrc.match(/readingRef\.current = false;/g) || []).length === 2
        && (panelSrc.match(/readingRef\.current = true;/g) || []).length === 1, show(loadSrc.length));
    // N5: Delete reads the table again right before it deletes, as Save does before its write. Order: the question, the
    // read, the check (deleteStoppedText: the row and the name the host value then shows), the delete.
    const deleteOrder = order(deleteSrc, ['const storedKey = storedKeyOf(row);', 'const after = nameAfterDelete(rows, row);',
        'window.confirm(deleteQuestion(row, after))', "setBusy('delete');", 'fresh = await readAllHostAliases();',
        'const stopped = deleteStoppedText(row, after, fresh.rows);', 'await deleteHostAlias(storedKey);']);
    check('E21 Delete: confirm, read again, check the row and the name after it, then delete (N5)', ascending(deleteOrder)
        && (deleteSrc.match(/\breadAllHostAliases\(/g) || []).length === 1
        && (deleteSrc.match(/\bdeleteHostAlias\(/g) || []).length === 1, show(deleteOrder));
    check('E21 Delete deletes nothing when the read fails or the check stops it, and shows the table as read on a stop',
        /fresh = await readAllHostAliases\(\);\s*\} catch \(e\) \{[^}]*Nothing was deleted: the host name table could not be read again before the delete[\s\S]*?return;\s*\}\s*const stopped/
            .test(deleteSrc)
        && /const stopped = deleteStoppedText\(row, after, fresh\.rows\);\s*if \(stopped !== null\) \{\s*if \(mountedRef\.current\) \{\s*applyRead\(fresh\);\s*setOpError\(stopped\);\s*setBusy\(null\);\s*\}\s*return;\s*\}\s*try \{\s*await deleteHostAlias\(storedKey\);/
            .test(deleteSrc), 'each stop path returns before the try that deletes');
    // The panel's pure helpers, lifted from its source (the TypeScript transpiler drops the types) and run: the
    // conflict texts, what Delete says when it stops (deleteStoppedText) and the plan comparison of Save and Import.
    const liftFrom = panelSrc.indexOf('\nconst OUTSIDE_TEXT =');
    const stoppedAt = panelSrc.indexOf('\nconst deleteStoppedText = (');
    const liftEnd = stoppedAt === -1 ? -1 : panelSrc.indexOf('\n};\n', stoppedAt);
    let lifted: any = null;
    let liftErr = '';
    if (liftFrom !== -1 && liftEnd > liftFrom) {
        try {
            const liftJs = ts.transpileModule(panelSrc.slice(liftFrom, liftEnd + 4),
                { compilerOptions: { target: ts.ScriptTarget.ES2017 } }).outputText;
            // eslint-disable-next-line no-new-func
            lifted = new Function('storedKeyOf', 'nameAfterDelete', `${liftJs}\nreturn { CONFLICT_NOTE, CONFLICT_TEXT, planText,`
                + ' sameEntry, deleteStoppedText };')(he.storedKeyOf, he.nameAfterDelete);
        } catch (e) {
            liftErr = e instanceof Error ? e.message : String(e);
        }
    }
    check('E21 the panel\'s pure helpers were lifted from its source', lifted !== null, liftErr || show([liftFrom, liftEnd]));
    const L: any = lifted || { CONFLICT_NOTE: '', CONFLICT_TEXT: '', planText: (): string => 'not lifted', sameEntry: (): boolean => false,
        deleteStoppedText: (): string => 'not lifted' };
    const payD = R({ match_value: 'app01.example.com', alias: 'Payroll', description: 'prod' });
    const webD = R({ match_value: 'web01', alias: 'Web' });
    const rowsD = [payD, webD];
    const afterD = he.nameAfterDelete(rowsD, payD);
    const SHOWN_D = 'The list now shows the table as it is.';
    const AGAIN_D = 'Press Delete again if you still want to delete it.';
    check('E21 deleteStoppedText: the table the question was asked over lets the delete go on, in any order and as new objects',
        afterD === null && L.deleteStoppedText(payD, afterD, rowsD) === null && L.deleteStoppedText(payD, afterD, [webD, payD]) === null
        && L.deleteStoppedText(payD, afterD, [{ ...webD }, { ...payD, updated_at: 99 }]) === null,
    show(L.deleteStoppedText(payD, afterD, rowsD)));
    check('E21 deleteStoppedText: the row gone', L.deleteStoppedText(payD, afterD, [webD]) === 'Nothing was deleted: the table read'
        + ` right before the delete no longer holds the entry for app01.example.com. ${SHOWN_D}`,
    String(L.deleteStoppedText(payD, afterD, [webD])));
    const renamedD = L.deleteStoppedText(payD, afterD, [webD, { ...payD, alias: 'HR' }]);
    const descD = L.deleteStoppedText(payD, afterD, [webD, { ...payD, description: 'test' }]);
    check('E21 deleteStoppedText: the row renamed, or only its description changed', renamedD === 'Nothing was deleted: the entry'
        + ' for app01.example.com changed after this page read the table; it now gives app01.example.com the name "HR".'
        + ` ${SHOWN_D} ${AGAIN_D}` && descD === 'Nothing was deleted: the entry for app01.example.com changed after this page read'
        + ` the table; only its description differs. ${SHOWN_D} ${AGAIN_D}`, show([renamedD, descD]));
    const shortD = R({ match_value: 'app01', alias: 'Short C' });
    const nowNamed = L.deleteStoppedText(payD, afterD, [webD, payD, shortD]);
    const nowBare = L.deleteStoppedText(payD, 'Short C', rowsD);
    check('E21 deleteStoppedText: the host value would now show another name than the question said, either way',
        nowNamed === 'Nothing was deleted: the host name table changed after this page read it. Without this entry,'
            + ' app01.example.com would now show as "Short C" on the dashboards, not without a name as the question said.'
            + ` ${SHOWN_D} ${AGAIN_D}`
        && nowBare === 'Nothing was deleted: the host name table changed after this page read it. Without this entry,'
            + ' app01.example.com would now show without a name on the dashboards, not as "Short C" as the question said.'
            + ` ${SHOWN_D} ${AGAIN_D}`
        && L.deleteStoppedText(payD, 'Short C', [webD, payD, shortD]) === null, show([nowNamed, nowBare]));
    // A row stored under a foreign key is found by that key: an own-key row of the host is another row.
    const foreignD = R({ _key: 'objid-7', match_value: 'app02', alias: 'Two' });
    const ownD = R({ match_value: 'app02', alias: 'Own two' });
    check('E21 deleteStoppedText finds the row by the key it is stored under', L.deleteStoppedText(foreignD, null, [foreignD]) === null
        && /no longer holds the entry for app02\./.test(String(L.deleteStoppedText(foreignD, null, [ownD])))
        && /would now show as "Own two" on the dashboards, not without a name/.test(String(L.deleteStoppedText(foreignD, null,
            [foreignD, ownD]))), '');
    check('E21 sameEntry compares host value, name and description (no description = empty), nothing else',
        L.sameEntry(payD, { ...payD, updated_at: 5, updated_by: 'x', stored_key: 'k' }) && L.sameEntry(webD, { ...webD, description: '' })
        && !L.sameEntry(payD, { ...payD, alias: 'payroll' }) && !L.sameEntry(payD, { ...payD, match_value: 'APP01.example.com' })
        && !L.sameEntry(payD, { ...payD, description: 'Prod' }), '');
    // KV-3 compares the plans with planText: the conflicted table read in another order gives the same text, so a
    // re-read in another order stops no Save or Import (N3).
    const base22Rev = base22.slice().reverse();
    check('E21 planText of the Save and Import plans over a conflicted table is the same in either read order',
        L.planText(he.planSave(R({ match_value: 'app01', alias: 'C' }), null, tableOf(base22)))
            === L.planText(he.planSave(R({ match_value: 'app01', alias: 'C' }), null, tableOf(base22Rev)))
        && L.planText(he.planSave(R({ match_value: 'app01', alias: 'A' }), k1, tableOf(base22)))
            === L.planText(he.planSave(R({ match_value: 'app01', alias: 'A' }), k1, tableOf(base22Rev)))
        && L.planText(he.planImport(parsedRows('host,alias\napp01,Z\n'), tableOf(base22)))
            === L.planText(he.planImport(parsedRows('host,alias\napp01,Z\n'), tableOf(base22Rev)))
        && L.planText({ a: 1 }) === '{"a":1}', '');
    // DOC-F2: the dashboards use none of a conflicted host's rows, and another entry can still name the host.
    check('E21 the conflict note and text say the dashboards use none of the rows, and that another entry can still name'
        + ' the host (DOC-F2)', L.CONFLICT_NOTE === 'rows give different names; the dashboards use none of them'
        && L.CONFLICT_TEXT === 'Two or more rows written outside this page give this host different names. None is stored under'
            + ' the key its host value gives, and the latest of them carry the same time of change (or none), so no rule picks'
            + ' one: the dashboards use none of them, so the host shows no name unless another entry covers it (a short-name'
            + ' entry covers its full names, for example); edit one of them and save it: this page stores it under the host\'s'
            + ' own key, and the dashboards use that row.'
        && !/dashboards show none|show no name for this host|two rows give different names/.test(panelSrc),
    show([L.CONFLICT_NOTE, L.CONFLICT_TEXT]));
    // DOC-F5: a batch the server answered with 200 but did not confirm may have been written.
    const flatPanel = panelSrc.replace(/\s+/g, ' ');
    check('E21 after a partial import the hint says the failed rows were not written or not confirmed (DOC-F5)',
        flatPanel.indexOf('The rows that failed were not written or not confirmed. The preview above now compares the file with'
            + ' the table as read after the import, so Import again writes only what still differs.') !== -1
        && flatPanel.indexOf('The rows that failed were not written.') === -1, 'the hint under a partial import');
}

/* ---- P the wiring ---- */
{
    const mod = read(path.join(HOME, 'utils/hostAlias.ts'));
    check('P1 hostAlias.ts imports nothing (gate-safe)', !/^\s*import\b/m.test(mod) && !/\brequire\(/.test(mod), 'it must stay pure');
    const shell = read(path.join(HOME, 'components/AppShell.tsx'));
    const open = shell.indexOf('<GlobalRefreshProvider>');
    const close = shell.indexOf('</GlobalRefreshProvider>');
    const at = shell.indexOf('<HostAliasProvider>');
    check('P2 AppShell mounts HostAliasProvider once, inside GlobalRefreshProvider (so Refresh reloads the names)',
        open !== -1 && at > open && at < close && shell.indexOf('<HostAliasProvider>', at + 1) === -1
        && shell.indexOf('</HostAliasProvider>') > at && shell.indexOf('</HostAliasProvider>') < close,
        `GlobalRefreshProvider ${open}-${close}, HostAliasProvider ${at}`);
    const walk = (dir: string, out: string[]): string[] => {
        fs.readdirSync(dir).forEach((name: string) => {
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) {
                walk(p, out);
            } else if (/\.tsx?$/.test(name) && !/consistency-test/.test(name)) {
                out.push(p);
            }
        });
        return out;
    };
    const mounts = walk(HOME, []).filter((p: string) => /<HostAliasProvider\b/.test(read(p)))
        .map((p: string) => path.relative(HOME, p).split(path.sep).join('/'));
    check('P2 no other file mounts it', same(mounts, ['components/AppShell.tsx']), show(mounts));
    const provider = read(path.join(HOME, 'state/HostAliasProvider.tsx'));
    check('P3 the provider reloads on the global Refresh nonce', /useGlobalRefresh\(\)/.test(provider)
        && /\[globalRefreshNonce, reloadNonce\]/.test(provider), 'the load effect must depend on globalRefreshNonce');
    // The catch branch: from the read's .catch( to the effect's cleanup.
    const catchAt = provider.indexOf('.catch(');
    const cleanupAt = catchAt === -1 ? -1 : provider.indexOf('return () => {', catchAt);
    const catchBranch = cleanupAt === -1 ? '' : provider.slice(catchAt, cleanupAt);
    check('P3 a failed read drops every name: its branch sets the empty map, unless no name is in use (then nothing changes)',
        /if \(signatureRef\.current !== EMPTY_SIGNATURE\) \{\s*signatureRef\.current = EMPTY_SIGNATURE;\s*setLoaded\(\(prev\) => \(\{ rows: \[\], index: EMPTY_ALIAS_INDEX, version: prev\.version \+ 1 \}\)\);\s*\}/
            .test(catchBranch) && /setError\(e instanceof Error \? e\.message : String\(e\)\);/.test(catchBranch)
        && (catchBranch.match(/setLoaded\(/g) || []).length === 1, `catch branch at ${catchAt}-${cleanupAt}`);
    const thenAt = provider.indexOf('.then((read) => {');
    const thenBranch = thenAt === -1 || catchAt < thenAt ? '' : provider.slice(thenAt, catchAt);
    check('P3 a read sorts its rows by key before the signature and the map (the KV order is not fixed)',
        /const rows = read\.rows\.slice\(\)\.sort\(byKey\);\s*const signature = JSON\.stringify\(rows\);/.test(thenBranch)
        && /const byKey = \(a: HostAliasRow, b: HostAliasRow\): number => \{\s*const \{ _key: keyA \} = a;\s*const \{ _key: keyB \} = b;\s*return compareText\(keyA, keyB\) \|\| compareText\(a\.stored_key \|\| '', b\.stored_key \|\| ''\);/
            .test(provider), 'rows must be sorted by _key, then stored_key, before JSON.stringify');
    check('P3 an empty table keeps the one empty map (resolve keeps its identity), from the first read on',
        /const nextIndex = rows\.length === 0 \? EMPTY_ALIAS_INDEX : buildAliasIndex\(rows\);/.test(thenBranch)
        && /useRef<string>\(EMPTY_SIGNATURE\)/.test(provider)
        && /const EMPTY_SIGNATURE = JSON\.stringify\(EMPTY\.rows\);/.test(provider)
        && /const EMPTY: Loaded = \{ rows: \[\], index: EMPTY_ALIAS_INDEX, version: 0 \};/.test(provider),
        'an empty read must use EMPTY_ALIAS_INDEX, and the signature start as the empty table\'s');
    check('P3 a read only replaces the map when its sorted rows differ (the same rows keep the same map and value)',
        /if \(signature !== signatureRef\.current\) \{\s*signatureRef\.current = signature;/.test(thenBranch)
        && (thenBranch.match(/setLoaded\(/g) || []).length === 1, 'setLoaded only under signature !== signatureRef.current');
    // A successful read clears the error whether or not its rows changed: after a failed read with no names in use the
    // signature is unchanged, so a clear under the signature test would leave the editor's banner up for good.
    const SIG_OPEN = 'if (signature !== signatureRef.current) {';
    const sigAt = thenBranch.indexOf(SIG_OPEN);
    let sigEnd = -1;
    let sigDepth = 0;
    for (let i = sigAt === -1 ? thenBranch.length : sigAt + SIG_OPEN.length - 1; i < thenBranch.length && sigEnd === -1; i += 1) {
        const c = thenBranch.charAt(i);
        if (c === '{') {
            sigDepth += 1;
        } else if (c === '}') {
            sigDepth -= 1;
            if (sigDepth === 0) {
                sigEnd = i;
            }
        }
    }
    const sigBlock = sigEnd === -1 ? '' : thenBranch.slice(sigAt, sigEnd + 1);
    const afterSig = sigEnd === -1 ? '' : thenBranch.slice(sigEnd + 1);
    check('P3 a successful read clears the error exactly once, after the signature test and outside it',
        sigBlock !== '' && sigBlock.indexOf('setError(') === -1 && (thenBranch.match(/\bsetError\(/g) || []).length === 1
        && /^\s*setError\(null\);\s*setLoading\(false\);\s*\}\)\s*$/.test(afterSig),
        `after the signature block: ${show(afterSig)}`);

    // P7 the names and the read's status are two contexts: loading flips on every read, so it stays out of the
    // value every DataTable, chart, Host filter and the topology consume, and only the editor reads it.
    const ifaceM = /export interface HostAliasContextValue \{([\s\S]*?)\n\}/.exec(provider);
    const iface = ifaceM ? ifaceM[1].replace(/\/\*\*[\s\S]*?\*\//g, '') : '';
    check('P7 the names\' value has no loading and no error', ifaceM !== null && /\bresolve\(raw: unknown\)/.test(iface)
        && !/\bloading\b|\berror\b/.test(iface), iface);
    const loadedM = /interface Loaded \{([\s\S]*?)\n\}/.exec(provider);
    check('P7 the names\' state holds no error (a failed read with no names in use changes nothing)',
        loadedM !== null && !/\berror\b/.test(loadedM[1]), loadedM ? loadedM[1] : 'no Loaded');
    check('P7 the status is its own context, with its own hook', /export interface HostAliasStatus \{[\s\S]*?\bloading: boolean;[\s\S]*?\berror: string \| null;/
        .test(provider) && /export const useHostAliasStatus = \(\): HostAliasStatus => useContext\(HostAliasStatusContext\);/.test(provider)
        && /const status = useMemo<HostAliasStatus>\(\(\) => \(\{ loading, error, reload \}\), \[loading, error, reload\]\);/.test(provider),
        'HostAliasStatusContext / useHostAliasStatus / the status memo');
    const valueM = /const value = useMemo<HostAliasContextValue>\(\s*\(\) => \(\{([\s\S]*?)\}\),\s*\[([^\]]*)\],\s*\);/.exec(provider);
    check('P7 the names\' value is memoised on the names only (no loading, no error)', valueM !== null
        && !/\bloading\b|\berror\b/.test(valueM[1])
        && valueM[2].split(',').map((x: string) => x.trim()).sort().join(',')
            === ['resolve', 'label', 'displayNames', 'loaded.rows', 'hasAliases', 'reload', 'loaded.version'].sort().join(','),
        valueM ? valueM[2] : 'no value memo');
    check('P7 both contexts are provided, the status around the names', /<HostAliasStatusContext\.Provider value=\{status\}>\s*<HostAliasContext\.Provider value=\{value\}>\{children\}<\/HostAliasContext\.Provider>\s*<\/HostAliasStatusContext\.Provider>/
        .test(provider), 'Status.Provider > HostAliasContext.Provider > children');
    // Code only: the comments name the hooks to explain them.
    const codeP7 = (p: string): string => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const relP7 = (p: string): string => path.relative(HOME, p).split(path.sep).join('/');
    const allFiles = walk(HOME, []);
    const statusUsers = allFiles.filter((p: string) => /\buseHostAliasStatus\(\)/.test(codeP7(p))).map(relP7).sort();
    check('P7 only the editor reads the status', same(statusUsers, ['components/HostAliasPanel.tsx']), show(statusUsers));
    const statusReaders: string[] = [];
    const nameUsers: string[] = [];
    allFiles.forEach((p: string) => {
        const src = codeP7(p);
        const re = /const \{([^}]*)\} = useHostAlias\(\);/g;
        for (let m = re.exec(src); m !== null; m = re.exec(src)) {
            nameUsers.push(relP7(p));
            if (/\b(loading|error)\b/.test(m[1])) {
                statusReaders.push(`${relP7(p)}: ${m[1].trim()}`);
            }
        }
        const whole = /const (\w+) = useHostAlias\(\);/g;
        for (let m = whole.exec(src); m !== null; m = whole.exec(src)) {
            nameUsers.push(relP7(p));
            if (new RegExp(`\\b${m[1]}\\.(loading|error)\\b`).test(src)) {
                statusReaders.push(`${relP7(p)}: ${m[1]}.loading / .error`);
            }
        }
        if (/useHostAlias\(\)\.(loading|error)\b/.test(src)) {
            statusReaders.push(`${relP7(p)}: useHostAlias().loading / .error`);
        }
        const calls = (src.match(/\buseHostAlias\(\)/g) || []).length;
        const seen = nameUsers.filter((f) => f === relP7(p)).length;
        if (calls !== seen) {
            statusReaders.push(`${relP7(p)}: ${calls} useHostAlias() call(s), ${seen} read here`);
        }
    });
    check('P7 no useHostAlias() consumer reads loading or error (each call destructured or named, and read here)',
        statusReaders.length === 0 && nameUsers.length > 0, show(statusReaders));
    const table = read(path.join(HOME, 'components/DataTable.tsx'));
    check('P4 ColumnDef declares hostAlias', /\n\s*hostAlias\?: boolean;/.test(table), 'ColumnDef must declare hostAlias?: boolean');
    check('P4 DataTable resolves an alias only for a flagged column without render',
        /const alias = col\.hostAlias && !col\.render \? resolveHostAlias\(raw\) : null;/.test(table)
        && (table.match(/resolveHostAlias\(/g) || []).length === 1, 'one call, behind col.hostAlias && !col.render');
    check('P4 with no alias the cell is today\'s text; a name replaces it only when there is one',
        /let content: ReactNode = col\.render\s*\? col\.render\(raw, row\)\s*: raw === null \|\| typeof raw === 'undefined'\s*\? ''\s*: String\(raw\);\s*(\/\/[^\n]*\n\s*)*if \(alias !== null\) \{\s*content = <AliasedHost alias=\{alias\} raw=\{String\(raw\)\} \/>;\s*\}/
            .test(table), 'the cell must stay render / \'\' / String(raw), with the AliasedHost only under alias !== null');
    check('P4 an aliased cell carries "name - raw" as its title (the whole cell, padding too; the name may be cut on'
        + ' screen); other cells none',
        /<Table\.Cell\s+key=\{col\.key\}\s*(\/\/[^\n]*\n\s*)*title=\{alias !== null \? `\$\{alias\} - \$\{String\(raw\)\}` : undefined\}/
            .test(table) && (table.match(/title=\{alias !== null/g) || []).length === 1,
        'Table.Cell must take title={alias !== null ? (alias - String(raw)) : undefined}');
    check('P4 an aliased cell also carries the line\'s copy handler (HostName.tsx copyOnOneLine); other cells none',
        /title=\{alias !== null \? `\$\{alias\} - \$\{String\(raw\)\}` : undefined\}\s*onCopy=\{alias !== null \? copyOnOneLine : undefined\}/
            .test(table) && (table.match(/onCopy=/g) || []).length === 1
        && /^import \{ AliasedHost, copyOnOneLine \} from '\.\/HostName';$/m.test(table),
        'Table.Cell must take onCopy={alias !== null ? copyOnOneLine : undefined}, imported from ./HostName');
    const chart = read(path.join(HOME, 'components/TimeSeriesChart.tsx'));
    check('P5 TimeSeriesChart names series through displayNames only with aliasSeries',
        /const seriesNamer = aliasSeries \? displayNames : null;/.test(chart), 'aliasSeries must gate the series names');
    check('P5 TimeSeriesChart names the series and builds the data through utils/aliasSeries (tested in V), with no copy of'
        + ' its own; without a namer the data is built as before build 400',
        /^import \{ rowsToColumnar, shownSeriesNames, withShownNames \} from '\.\.\/utils\/aliasSeries';$/m.test(chart)
        && (chart.match(/\bshownSeriesNames\(/g) || []).length === 1
        && /const \{ shownKeys, shownByRaw \} = shownSeriesNames\(valueKeys, seriesNamer\);/.test(chart)
        && /const data = seriesNamer\s*\? rowsToColumnar\(allRows, fieldNames, hasTime \? \['_time', \.\.\.shownKeys\] : shownKeys\)\s*: rowsToColumnar\(allRows, fieldNames\);/
            .test(chart)
        && /shownByRaw && finalFieldColors \? withShownNames\(finalFieldColors, shownByRaw\) : finalFieldColors/.test(chart)
        && !/\b(const|function)\s+(rowsToColumnar|withShownNames|shownSeriesNames|namedFields)\b/.test(chart)
        && /\}, \[results, valueFields, seriesNamer\]\);/.test(chart),
    'the aliasSeries import, one shownSeriesNames call, the two-branch rowsToColumnar and the colour copy');
    const hostName = read(path.join(HOME, 'components/HostName.tsx'));
    const hostNameCode = hostName.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    check('P6 AliasedHost: "name - raw" is the title of the whole line (the raw value, or the name too, may be cut on'
        + ' screen), and a text separator sits between the name and the raw value (copies and screen readers do not'
        + ' run them together); one kind of name for every user (build 403: no compact variant, no cap)',
        /<Line title=\{`\$\{alias\} - \$\{raw\}`\} onCopy=\{copyOnOneLine\}>\s*<SizeName aria-hidden="true">\{name\}<\/SizeName>\s*<SizeRaw aria-hidden="true">\{value\}<\/SizeRaw>\s*<Shown data-export-line="">\s*<ShownName data-export-part="name">\{name\}<\/ShownName>\s*<Separator>\{' - '\}<\/Separator>\s*<ShownRaw data-export-part="raw">\{value\}<\/ShownRaw>\s*<\/Shown>\s*<\/Line>/
            .test(hostName)
        && /export const AliasedHost: React\.FC<AliasedHostProps> = \(\{ alias, raw \}\) => \{\s*(\/\/[^\n]*\n\s*)*const name = alias\.trim\(\);\s*const value = raw\.trim\(\);\s*return \(/
            .test(hostName)
        && !/\bcompact\b|CompactName|NameText/.test(hostNameCode)
        && (hostName.match(/<Line title=/g) || []).length === 1
        && (hostNameCode.match(/data-export-line/g) || []).length === 1
        && (hostNameCode.match(/data-export-part="name"/g) || []).length === 1
        && (hostNameCode.match(/data-export-part="raw"/g) || []).length === 1,
        'expected <Line title={(alias - raw)} onCopy={copyOnOneLine}><SizeName aria-hidden>{name}<SizeRaw aria-hidden>{value}'
        + '<Shown data-export-line><ShownName data-export-part="name">{name}<Separator>{\' - \'}</Separator>'
        + '<ShownRaw data-export-part="raw">{value}</Shown></Line>, name = alias.trim(), value = raw.trim() (the same'
        + ' texts in both layers), no compact variant');
    check('P6 copyOnOneLine (exported, for the cells that hold a line): one range inside the enclosing table cell (the'
        + ' line outside a table) is written as text/plain without its line breaks (a flex row copies as three lines);'
        + ' any other selection is left to the browser',
        /\nexport const copyOnOneLine = \(e: React\.ClipboardEvent<HTMLElement>\): void => \{/.test(hostName)
        && /if \(!selection \|\| selection\.rangeCount !== 1 \|\| !e\.clipboardData\) \{\s*return;\s*\}/.test(hostName)
        && /const cell = e\.currentTarget\.closest\('td'\);\s*const box: HTMLElement = cell \|\| e\.currentTarget;\s*const range = selection\.getRangeAt\(0\);/
            .test(hostName)
        && /if \(box\.contains\(range\.commonAncestorContainer\)\) \{\s*text = selection\.toString\(\);\s*\} else if \(/.test(hostName)
        && /\} else \{\s*return;\s*\}\s*e\.clipboardData\.setData\('text\/plain', text\.replace\(\/\[\\r\\n\]\+\/g, ''\)\);\s*e\.preventDefault\(\);/
            .test(hostName) && hostName.indexOf('e.currentTarget.contains(') === -1,
        'copyOnOneLine: guard, the enclosing td (or the line), the in-cell range -> selection text without line breaks');
    check('P6 copyOnOneLine: a range that starts inside the cell and ends at the very start of the next cell (offset 0'
        + ' of it, or of a node reached through first children) writes the text from its start to this cell\'s end;'
        + ' only in a table cell',
        /\} else if \(\s*cell !== null &&\s*cell\.contains\(range\.startContainer\) &&\s*isStartOf\(cell\.nextElementSibling, range\.endContainer, range\.endOffset\)\s*\) \{\s*const inCell = range\.cloneRange\(\);\s*inCell\.setEnd\(cell, cell\.childNodes\.length\);\s*text = inCell\.toString\(\);\s*\}/
            .test(hostName)
        && /const isStartOf = \(cell: Element \| null, node: Node, offset: number\): boolean => \{\s*if \(cell === null \|\| offset !== 0\) \{\s*return false;\s*\}\s*let n: Node = node;\s*while \(n !== cell\) \{\s*const parent = n\.parentNode;\s*if \(parent === null \|\| parent\.firstChild !== n\) \{\s*return false;\s*\}\s*n = parent;\s*\}\s*return true;\s*\};/
            .test(hostName),
        'the next-cell branch and isStartOf (offset 0, first children only, up to the next cell)');
    // R3: HostName's default export is used nowhere in this build; every import of the module names AliasedHost and
    // copyOnOneLine only, so a new user of the default component is a reviewed change.
    const hostNameImports: string[] = [];
    walk(HOME, []).forEach((p: string) => {
        (read(p).match(/import [^;]*? from '[^']*\/HostName';/g) || []).forEach((m: string) => hostNameImports.push(m));
    });
    check('P6 nothing imports HostName\'s default export (its imports are named: AliasedHost, copyOnOneLine)',
        hostNameImports.length > 0 && hostNameImports.every((m: string) => /^import \{ [\w, ]+ \} from/.test(m)
            && m.replace(/^import \{ ([\w, ]+) \}[\s\S]*$/, '$1').split(', ').every((n: string) => ['AliasedHost', 'copyOnOneLine']
                .indexOf(n) !== -1)), show(hostNameImports));
    const cssOf = (name: string): string => {
        const m = new RegExp(`const ${name} = styled\\.span\`([^\`]*)\``).exec(hostName);
        return m ? m[1] : '';
    };
    const sep = cssOf('Separator');
    check('P6 the separator is visually hidden, not removed (display: none would drop it from copies)',
        /position: absolute;/.test(sep) && /clip: rect\(0 0 0 0\);/.test(sep) && /white-space: pre;/.test(sep)
        && !/display:\s*none/.test(sep) && !/visibility:\s*hidden/.test(sep), sep);
    const lineCss = cssOf('Line');
    const nameCss = cssOf('SizeName');
    const rawCss = cssOf('SizeRaw');
    const shownCss = cssOf('Shown');
    const shownNameCss = cssOf('ShownName');
    const shownRawCss = cssOf('ShownRaw');
    // Build 403: two layers. The hidden SIZER keeps the narrowest column of builds 400-402 (the name breaks at any
    // character and is clamped to one line, so its narrowest width is about one character; the raw value stays on one
    // line, capped at 16em). The TEXT lies over it (absolute, the same box) and is one run of text on one line that
    // the browser cuts at its right end with one ellipsis: the raw value gives way first, the name only after it.
    // Build 406: the declarations are read by splitting the block on ';' (comments out), not by matching the start
    // of a line, so a second declaration on a line or one written after an interpolation is seen. A block that holds
    // anything else (a nested rule, a bare interpolation) reads as '<not a declaration>' and fails the checks below.
    const declsOf = (css: string): Array<[string, string]> => {
        const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const nested = /[{}]/.test(noComments.replace(/\$\{[^}]*\}/g, ''));
        const out: Array<[string, string]> = noComments.split(';').map((d: string) => d.trim()).filter((d: string) => d !== '')
            .map((d: string): [string, string] => {
                const m = /^([-a-z]+)\s*:\s*(\S[\s\S]*)$/.exec(d);
                return m && !nested ? [m[1], m[2].trim()] : ['<not a declaration>', d];
            });
        return out;
    };
    const decl = (css: string, prop: string): string[] => declsOf(css).filter((d) => d[0] === prop).map((d) => d[1]);
    const propsOf = (css: string): string[] => declsOf(css).map((d) => d[0]).sort();
    check('P6 the reader sees a declaration wherever it sits, and a block with a nested rule or a bare interpolation fails',
        same(propsOf('a: 1; b: 2;\n  c: ${x}; d: 4'), ['a', 'b', 'c', 'd']) && same(decl('a: 1; a: ${y};', 'a'), ['1', '${y}'])
        && same(propsOf('a: 1;\n ${mixin};'), ['<not a declaration>', 'a'])
        && same(propsOf('a: 1;\n &:hover { b: 2; }'), ['<not a declaration>', '<not a declaration>', '<not a declaration>'])
        && same(propsOf('/* x: 1; */ a: 1;'), ['a']),
        show([propsOf('a: 1; b: 2;\n  c: ${x}; d: 4'), propsOf('a: 1;\n ${mixin};'), propsOf('a: 1;\n &:hover { b: 2; }')]));
    check('P6 each layer declares exactly its own properties: nothing that hides, moves or flips the text layer'
        + ' (no display, visibility, opacity, direction, transform, padding), and the two layers in the same font'
        + ' (the name\'s weight in both, no other font property anywhere)',
        same(propsOf(shownCss), ['bottom', 'left', 'overflow', 'position', 'right', 'text-overflow', 'top', 'white-space'])
        && same(propsOf(shownNameCss), ['font-weight']) && same(propsOf(shownRawCss), ['color', 'margin-left'])
        && same(propsOf(nameCss), ['-webkit-box-orient', '-webkit-line-clamp', 'display', 'flex', 'font-weight', 'min-width',
            'overflow', 'overflow-wrap', 'visibility', 'white-space', 'word-break'])
        && same(propsOf(rawCss), ['flex', 'margin-left', 'max-width', 'min-width', 'overflow', 'visibility', 'white-space'])
        && same(decl(shownNameCss, 'font-weight'), decl(nameCss, 'font-weight')) && decl(nameCss, 'font-weight').length === 1
        && same(propsOf(lineCss), ['align-items', 'display', 'max-width', 'min-width', 'overflow', 'position', 'vertical-align']),
        `Shown ${show(propsOf(shownCss))} ShownName ${show(propsOf(shownNameCss))} ShownRaw ${show(propsOf(shownRawCss))}`
        + ` SizeName ${show(propsOf(nameCss))} SizeRaw ${show(propsOf(rawCss))} Line ${show(propsOf(lineCss))}`);
    check('P6 the text layer: absolute over the sizer (all four edges 0), one line, clipped, cut with an ellipsis at'
        + ' its end; its name and raw value are plain inline runs (no flex, no box of their own that clips), the raw'
        + ' value after a 6 px gap in the muted colour',
        same(decl(shownCss, 'position'), ['absolute']) && ['top', 'right', 'bottom', 'left'].every((e: string) =>
            same(decl(shownCss, e), ['0'])) && same(decl(shownCss, 'overflow'), ['hidden'])
        && same(decl(shownCss, 'white-space'), ['nowrap']) && same(decl(shownCss, 'text-overflow'), ['ellipsis'])
        && decl(shownCss, 'display').length === 0
        && !/\b(display|overflow|flex|max-width|width|white-space|text-overflow|position)\s*:/.test(shownNameCss + shownRawCss)
        && same(decl(shownRawCss, 'margin-left'), ['6px']) && /color: \$\{logservTheme\.colors\.textMuted\};/.test(shownRawCss)
        && /visibility: hidden;/.test(nameCss) && /visibility: hidden;/.test(rawCss)
        && same(decl(rawCss, 'margin-left'), ['6px']),
        `Shown: ${shownCss} ShownName: ${shownNameCss} ShownRaw: ${shownRawCss}`);
    check('P6 the sizer keeps the narrowest column of builds 400-402 and adds no line (its name: flex 0 1 auto, no'
        + ' max-width since build 403, breaks at any character, clamped to one line; its raw value: flex 1 1 0%, one'
        + ' line, capped at 16em); both hidden',
        /position: relative;/.test(lineCss) && /display: inline-flex;/.test(lineCss) && /max-width: 100%;/.test(lineCss)
        && /min-width: 0;/.test(lineCss) && /overflow: hidden;/.test(lineCss) && !/white-space:/.test(lineCss)
        && same(decl(nameCss, 'flex'), ['0 1 auto']) && same(decl(nameCss, 'min-width'), ['0'])
        && decl(nameCss, 'max-width').length === 0 && decl(nameCss, 'flex-basis').length === 0
        && decl(nameCss, 'flex-shrink').length === 0 && decl(nameCss, 'flex-grow').length === 0
        && same(decl(nameCss, 'overflow'), ['hidden']) && same(decl(nameCss, 'display'), ['-webkit-box'])
        && same(decl(nameCss, '-webkit-box-orient'), ['vertical']) && same(decl(nameCss, '-webkit-line-clamp'), ['1'])
        && same(decl(nameCss, 'white-space'), ['normal']) && same(decl(nameCss, 'overflow-wrap'), ['anywhere'])
        && same(decl(nameCss, 'word-break'), ['break-all'])
        && same(decl(rawCss, 'flex'), ['1 1 0%']) && same(decl(rawCss, 'min-width'), ['0'])
        && same(decl(rawCss, 'max-width'), ['16em']) && decl(rawCss, 'flex-basis').length === 0
        && decl(rawCss, 'flex-shrink').length === 0 && decl(rawCss, 'flex-grow').length === 0
        && same(decl(rawCss, 'overflow'), ['hidden']) && same(decl(rawCss, 'white-space'), ['nowrap'])
        && same(decl(nameCss, 'visibility'), ['hidden']) && same(decl(rawCss, 'visibility'), ['hidden'])
        && !/styled\((SizeName|SizeRaw|Shown|ShownName|ShownRaw)\)/.test(hostName),
        `Line: ${lineCss} SizeName: ${nameCss} SizeRaw: ${rawCss}`);
}

/* ---- Q the surfaces: where the names show, and that everything else keeps the raw value ---- */
{
    const rel = (p: string): string => path.relative(HOME, p).split(path.sep).join('/');
    const sourceFiles = (dir: string, out: string[]): string[] => {
        fs.readdirSync(dir).forEach((name: string) => {
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) {
                sourceFiles(p, out);
            } else if (/\.tsx?$/.test(name) && !/consistency-test/.test(name)) {
                out.push(p);
            }
        });
        return out;
    };
    const ALL = sourceFiles(HOME, []).sort();
    const DASHBOARDS = ALL.filter((p: string) => /^dashboards\/[^/]+\.tsx$/.test(rel(p)));
    // Code lines only: whole-line // comments and the lines of /* */ blocks are left out (enough for these pins).
    const codeOf = (src: string): string => src.split('\n').filter((ln: string) => !/^\s*(\/\/|\/\*|\*)/.test(ln)).join('\n');
    const dash = (name: string): string => read(path.join(HOME, 'dashboards', name));

    // Q1 every host and IP column (the build-400 inventory). A flagged column must be a plain one: no render
    // (DataTable names only default cells), key and label adjacent (check-diagnostics' column regex).
    const COLUMN_RE = /\{ key: '([^']+)', label: '([^']+)'(?:, width: '\d+px')?, hostAlias: true(?:, width: '\d+px')? \}/g;
    const EXPECTED_COLUMNS: { [file: string]: string[] } = {
        'AbapSecurity.tsx': ['Peer IP', 'Remote Host'],
        'ChangeConfig.tsx': ['HANA Host', 'Client Host', 'Computer', 'Host'],
        'CloudConnector.tsx': ['Client IP'],
        'CrossStackAuthentication.tsx': ['Source IP', 'Source IP', 'host', 'Remote IP', 'host'],
        'DataPipelineOverview.tsx': ['host'],
        'DnsAnalytics.tsx': ['Client IP', 'Resolver'],
        'EnvironmentHealth.tsx': ['host', 'host'],
        'HanaAudit.tsx': ['client_ip', 'host', 'client_ip', 'host', 'src_host', 'client_ip', 'host', 'src_host', 'client_ip'],
        'HostDetails.tsx': ['Host'],
        'Linux.tsx': ['fw_src', 'host', 'host'],
        'NetworkPerimeter.tsx': ['Source IP', 'Host'],
        'Proxy.tsx': ['Client IP', 'Client IP'],
        'SapRouter.tsx': ['Peer IP', 'Peer IP', 'Source IP'],
        'SapServices.tsx': ['Remote IP', 'Source IP'],
        'WebApiPerformance.tsx': ['Client IP', 'Host', 'Client IP'],
        'WebDispatcher.tsx': ['clientip', 'clientip'],
        'WorkProcessPerformance.tsx': ['host'],
    };
    const found: { [file: string]: string[] } = {};
    const labels: string[] = [];
    let strayFlags = '';
    DASHBOARDS.forEach((p: string) => {
        const code = codeOf(read(p));
        const keys: string[] = [];
        COLUMN_RE.lastIndex = 0;
        for (let m = COLUMN_RE.exec(code); m !== null; m = COLUMN_RE.exec(code)) {
            keys.push(m[1]);
            labels.push(`${m[1]} / ${m[2]}`);
        }
        const flags = (code.match(/hostAlias: true/g) || []).length;
        if (flags !== keys.length) {
            strayFlags += `${rel(p)}: ${flags} flags, ${keys.length} plain flagged columns; `;
        }
        if (keys.length > 0) {
            found[path.basename(p)] = keys;
        }
    });
    check('Q1 the flagged host and IP columns, dashboard by dashboard (45)', same(found, EXPECTED_COLUMNS), show(found));
    check('Q1 every flag sits on a plain column: no render, key and label first', strayFlags === '', strayFlags);
    const notHosts = labels.filter((l) => /domain|url|uri|query|user|destination|account|sid\b|location|sourcetype/i.test(l));
    check('Q1 no flagged column holds a URL, a domain, a DNS query, a user, a SID or a sourcetype', notHosts.length === 0, show(notHosts));
    const hd = dash('HostDetails.tsx');
    check('Q1 Host Details\' colsForKey passes the flag after key and label',
        /const colsForKey = \(key: string, label: string, hostAlias\?: boolean\): ColumnDef\[\] => \[\n\s*\{ key, label, hostAlias \},/.test(hd),
        'colsForKey must build { key, label, hostAlias }');
    const flaggedCalls = codeOf(hd).match(/colsForKey\('[^']*', '[^']*', [^)]*\)/g) || [];
    check('Q1 only the SAP Router Peers table passes it', same(flaggedCalls, ['colsForKey(\'peer_ip\', \'Peer IP\', true)']), show(flaggedCalls));

    // Q2 the design's drilldown check: DataTable hands a row click the raw row and sorts on the raw values, so
    // every drilldown of a flagged column reads the raw key (the name exists only in the cell, P4).
    const table = read(path.join(HOME, 'components/DataTable.tsx'));
    check('Q2 a row click gets the raw row', /onClick=\{onRowClick \? \(\) => onRowClick\(row\) : undefined\}/.test(table),
        'onRowClick must be called with the row itself');
    check('Q2 sorting compares the raw values', /compareValues\(a\[sortKey\], b\[sortKey\]\)/.test(table), 'sort must read row[sortKey]');

    // Q3 the host lists: an option shows "name (raw)" and its value stays the raw host.
    const optionSites: string[] = [];
    let aliasValue = '';
    DASHBOARDS.forEach((p: string) => {
        // A context provider's value (IntegrationTopology hands NodeAliasContext the resolver) is not a pick.
        const code = codeOf(read(p)).replace(/\.Provider value=\{\w+\}/g, '.Provider');
        (code.match(/<Multiselect\.Option key=\{(\w+)\} label=\{aliasLabel\(\1\)\} value=\{\1\}/g) || [])
            .forEach(() => optionSites.push(path.basename(p)));
        if (/value=\{[^}]*(aliasLabel|resolveHostAlias|displayNames|aliasHostColumn)\b/.test(code)) {
            aliasValue += `${rel(p)} `;
        }
    });
    check('Q3 the three host lists label options "name (raw)" with the raw host as the value',
        same(optionSites.sort(), ['DataPipelineOverview.tsx', 'DnsAnalytics.tsx', 'HostDetails.tsx']), show(optionSites));
    check('Q3 no value={...} in a dashboard holds a name', aliasValue === '', aliasValue);

    // Q4 the per-host charts.
    const seriesCharts: { [file: string]: number } = {};
    DASHBOARDS.forEach((p: string) => {
        const n = (codeOf(read(p)).match(/\baliasSeries\b/g) || []).length;
        if (n > 0) {
            seriesCharts[path.basename(p)] = n;
        }
    });
    check('Q4 aliasSeries on the three per-host charts only',
        same(seriesCharts, { 'DataPipelineOverview.tsx': 1, 'DnsAnalytics.tsx': 1, 'Linux.tsx': 1 }), show(seriesCharts));

    // Q5 the two Sourcetype Mapping link graphs name host nodes through the one tested helper.
    ['DataPipelineOverview.tsx', 'HostDetails.tsx'].forEach((name) => {
        const code = codeOf(dash(name));
        check(`Q5 ${name}: the link graph's host column goes through utils/hostAlias aliasHostColumn`,
            /import \{ aliasHostColumn \} from '\.\.\/utils\/hostAlias';/.test(code)
            && (code.match(/const hostCol = aliasHostColumn\(results\.map\(\(r\) => String\(r\.host \?\? ''\)\), displayNames\);/g) || [])
                .length === 1, 'one aliasHostColumn call on the raw host column, imported from utils/hostAlias');
    });
    const ownCopies = DASHBOARDS.filter((p: string) => /const aliasHostColumn\b/.test(read(p))).map(rel);
    check('Q5 no dashboard keeps its own copy of the helper', ownCopies.length === 0, show(ownCopies));

    // Q6 a name never reaches a URL, a navigation, a stored selection, SPL or a picker's onChange (line by line).
    const NAME_CALL = /\b(aliasLabel|resolveHostAlias|displayNames|aliasHostColumn|hostButtonLabel|topDropAlias)\b|\bresolve\(/;
    // URL-parameter writes too: Host Details writes its ?host= / ?hosts= that way. `URLSearchParams` and
    // `searchParams` already cover new URLSearchParams(...) and searchParams.set / append; params.set / append
    // and setSearchParams( (a capital S) are the terms they miss.
    const RAW_SINK = /buildSplunkSearchUrl|buildOpenInSearchUrl|buildJobInspectorUrl|buildHostDetailsUrl|openInNewTab|navigate\(|history\.push|setHosts|setServiceHosts|setSelected|localStorage|sessionStorage|URLSearchParams|searchParams|\bparams\.(set|append)\(|setSearchParams\(|onChange\(|splQuote\(|withCloudProvider\(|host="/;
    const leaks: string[] = [];
    DASHBOARDS.concat([path.join(HOME, 'components/SidHostPicker.tsx')]).forEach((p: string) => {
        codeOf(read(p)).split('\n').forEach((ln: string) => {
            if (NAME_CALL.test(ln) && RAW_SINK.test(ln)) {
                leaks.push(`${rel(p)}: ${ln.trim()}`);
            }
        });
    });
    check('Q6 no line passes a name to a URL, a URL parameter, a stored selection, SPL or onChange', leaks.length === 0, show(leaks));
    const SINK_CASES = ["params.set('host', hosts[0]);", "params.append('hosts', h);", "searchParams.set('host', h);",
        "searchParams.append('host', h);", 'setSearchParams(next, { replace: true });', 'const next = new URLSearchParams(x);'];
    check('Q6 the URL-parameter writes are sinks', SINK_CASES.every((c) => RAW_SINK.test(c)),
        show(SINK_CASES.filter((c) => !RAW_SINK.test(c))));

    // Q6 by the syntax tree (T7): a name kept in a variable on one line and used on another. A variable is a name when
    // its initializer (or an assignment to it) holds a name call or another such variable, followed through the
    // TypeScript checker's symbols (so two variables called `host` in two functions stay two). A name reaches a sink
    // when it is in the arguments of a URL builder, a navigation, a storage or URL-parameter write, onChange, an SPL
    // helper, a state setter (set...), new URLSearchParams, an href / to / value attribute, or a template that reads
    // like SPL (host=, index=, sourcetype=, source=, or a leading pipe). Predicate callbacks (filter, some, every, find,
    // findIndex, sort, forEach, includes, indexOf) return no name, so a name used inside one taints nothing.
    // What this still cannot see: a name passed as a function argument and used in the callee, or kept in an object
    // field and read back later.
    const nameFlowLeaks = (files: Array<{ name: string; text: string }>): string[] => {
        const byName: { [n: string]: string } = {};
        files.forEach((f) => {
            byName[f.name] = f.text;
        });
        const has = (n: string): boolean => Object.prototype.hasOwnProperty.call(byName, n);
        const host = {
            getSourceFile: (n: string, lv: any): any => (has(n)
                ? ts.createSourceFile(n, byName[n], lv, true, /\.tsx$/.test(n) ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : undefined),
            getDefaultLibFileName: (): string => '/lib.d.ts',
            writeFile: (): void => undefined,
            getCurrentDirectory: (): string => '/',
            getCanonicalFileName: (n: string): string => n,
            useCaseSensitiveFileNames: (): boolean => true,
            getNewLine: (): string => '\n',
            fileExists: (n: string): boolean => has(n),
            readFile: (n: string): string | undefined => (has(n) ? byName[n] : undefined),
            getDirectories: (): string[] => [],
        };
        const prog = ts.createProgram(files.map((f) => f.name), { noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve,
            target: ts.ScriptTarget.ES2017, noEmit: true }, host);
        const checker = prog.getTypeChecker();
        const out: string[] = [];
        const HOOK_FIELDS = ['resolve', 'label', 'displayNames'];
        const PRED = /^(filter|some|every|find|findIndex|sort|forEach|includes|indexOf)$/;
        const SINK = new RegExp('^(buildSplunkSearchUrl|buildOpenInSearchUrl|buildJobInspectorUrl|buildHostDetailsUrl|buildDashboardUrl'
            + '|buildResultsExportUrl|openInNewTab|navigate|(window\\.)?history\\.(push|replace)|(\\w+\\.)?onChange|splQuote'
            + '|withCloudProvider|withQueryFilters|(window\\.)?(localStorage|sessionStorage)\\.setItem'
            + '|(\\w+\\.)?(params|searchParams)\\.(set|append)|set[A-Z]\\w*)$');
        files.forEach((f) => {
            const sf = prog.getSourceFile(f.name);
            const all: any[] = [];
            const collect = (n: any): void => {
                all.push(n);
                ts.forEachChild(n, collect);
            };
            collect(sf);
            // The name functions: the module helpers, and whatever this file binds from useHostAlias() resolve / label / displayNames.
            const nameFns: { [n: string]: true } = { aliasLabel: true, resolveHostAlias: true, displayNames: true, aliasHostColumn: true,
                hostButtonLabel: true, resolve: true };
            all.forEach((n: any) => {
                if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
                    && n.initializer.expression.getText(sf) === 'useHostAlias' && ts.isObjectBindingPattern(n.name)) {
                    n.name.elements.forEach((el: any) => {
                        const prop = (el.propertyName || el.name).getText(sf);
                        if (HOOK_FIELDS.indexOf(prop) !== -1) {
                            nameFns[el.name.getText(sf)] = true;
                        }
                    });
                }
            });
            const isNameCall = (n: any): boolean => ts.isCallExpression(n) && ((ts.isIdentifier(n.expression)
                && Object.prototype.hasOwnProperty.call(nameFns, n.expression.text))
                || (ts.isPropertyAccessExpression(n.expression) && HOOK_FIELDS.indexOf(n.expression.name.text) !== -1
                    && ts.isCallExpression(n.expression.expression) && n.expression.expression.expression.getText(sf) === 'useHostAlias'));
            const taint = new Set<any>();
            const symOf = (id: any): any => (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
                ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id));
            const holdsName = (node: any): boolean => {
                let hit = false;
                const walk = (n: any): void => {
                    if (hit) {
                        return;
                    }
                    if (isNameCall(n) || (ts.isIdentifier(n) && taint.has(symOf(n)))) {
                        hit = true;
                        return;
                    }
                    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent)
                        && ts.isPropertyAccessExpression(n.parent.expression) && PRED.test(n.parent.expression.name.text)) {
                        return;
                    }
                    ts.forEachChild(n, walk);
                };
                walk(node);
                return hit;
            };
            const bound = (b: any, acc: any[]): any[] => {
                if (ts.isIdentifier(b)) {
                    acc.push(b);
                } else {
                    b.elements.forEach((e: any) => {
                        if (!ts.isOmittedExpression(e)) {
                            bound(e.name, acc);
                        }
                    });
                }
                return acc;
            };
            /** One pass over the declarations and assignments: true when it found a new name variable. */
            const spread = (): boolean => {
                let changed = false;
                all.forEach((n: any) => {
                    let targets: any[] = [];
                    if (ts.isVariableDeclaration(n) && n.initializer && !ts.isArrowFunction(n.initializer)
                        && !ts.isFunctionExpression(n.initializer)
                        && !(ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === 'useCallback')
                        && holdsName(n.initializer)) {
                        targets = bound(n.name, []);
                    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
                        && holdsName(n.right)) {
                        targets = [n.left];
                    }
                    targets.forEach((id: any) => {
                        const s = checker.getSymbolAtLocation(id);
                        if (s && !taint.has(s)) {
                            taint.add(s);
                            changed = true;
                        }
                    });
                });
                return changed;
            };
            let more = true;
            while (more) {
                more = spread();
            }
            all.forEach((n: any) => {
                let args: any[] | null = null;
                if (ts.isCallExpression(n) && SINK.test(n.expression.getText(sf).replace(/\s+/g, ''))) {
                    args = Array.from(n.arguments);
                } else if (ts.isNewExpression(n) && n.expression.getText(sf) === 'URLSearchParams') {
                    args = n.arguments ? Array.from(n.arguments) : [];
                } else if (ts.isTemplateExpression(n)
                    && /\b(host|index|sourcetype|source)\s*=|^\s*\|/.test(n.head.text + n.templateSpans.map((s: any) => s.literal.text).join(''))) {
                    args = n.templateSpans.map((s: any) => s.expression);
                } else if (ts.isJsxAttribute(n) && /^(href|to|value)$/.test(n.name.getText(sf)) && n.initializer
                    && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
                    args = [n.initializer.expression];
                }
                if (args !== null && args.some((a: any) => holdsName(a))) {
                    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
                    out.push(`${f.name}:${line + 1}: ${n.getText(sf).replace(/\s+/g, ' ').slice(0, 120)}`);
                }
            });
        });
        return out;
    };
    const Q6_FILES = DASHBOARDS.concat([path.join(HOME, 'components/SidHostPicker.tsx')]);
    const flowLeaks = nameFlowLeaks(Q6_FILES.map((p: string) => ({ name: `/q6/${rel(p)}`, text: read(p) })));
    check('Q6 no name reaches a URL, a stored selection, SPL, onChange or a state setter through a variable (syntax tree)',
        flowLeaks.length === 0 && Q6_FILES.length > 20, show(flowLeaks));
    // The known cases: each LEAK must be found (the first is the audit's M10: Data Pipeline Overview's goHostRow with the
    // name assigned on one line and opened on the next), and no SAFE one.
    const Q6_LEAK: { [k: string]: string } = {
        m10: 'const C = (): null => {\n    const { resolve } = useHostAlias();\n    const goHostRow = (row: any): void => {\n'
            + "        const host = resolve(String(row.host ?? '')) ?? String(row.host ?? '');\n"
            + '        openInNewTab(buildHostDetailsUrl(host, earliest, latest));\n    };\n    return null;\n};\n',
        chain: 'const f = (h: string): void => { const a = aliasLabel(h); const b = a.trim(); navigate(b); };\n',
        setter: 'const f = (x: string): void => { const n = resolveHostAlias(x); setSelected([n]); };\n',
        stateSetter: 'const f = (x: string): void => { const n = resolveHostAlias(x); setPinnedHost(n); };\n',
        shorthand: 'const f = (x: string): void => { const host = resolve(x); setSearchParams({ host }); };\n',
        // The substitution is spelled in two pieces so that this file holds no template placeholder in a plain string.
        spl: 'const f = (x: string): string => { const name = displayNames([x])[0]; return `index=main host="$'
            + '{name}"`; };\n',
        params: "const f = (h: string): void => { const params = new URLSearchParams(); const label = aliasLabel(h);"
            + " params.set('host', label); };\n",
        assign: 'const f = (h: string): void => { let v = h; v = resolve(h) ?? h; openInNewTab(buildHostDetailsUrl(v)); };\n',
        destructured: 'const f = (rows: any[]): void => { const [first] = aliasHostColumn(rows, displayNames); navigate(first); };\n',
        mapped: 'const f = (hs: string[]): void => { const names = hs.map((h) => aliasLabel(h)); setHosts(names); };\n',
        href: 'const f = (h: string): any => { const n = aliasLabel(h); return <a href={n}>x</a>; };\n',
        viaHook: 'const f = (h: string): void => { onChange([useHostAlias().resolve(h)]); };\n',
        renamedHook: 'const f = (h: string): void => { const { label: nameOf } = useHostAlias(); const t = nameOf(h);'
            + ' openInNewTab(buildOpenInSearchUrl(t)); };\n',
    };
    const Q6_SAFE: { [k: string]: string } = {
        scoped: 'const A = (x: string): string => { const host = resolve(x) ?? x; return host; };\n'
            + 'const B = (row: any): void => { const host = String(row.host); openInNewTab(buildHostDetailsUrl(host)); };\n',
        predicate: "const f = (options: any[], filter: string): void => { const shown = options.filter((h) => matches(filter,"
            + " resolve(h.host) ?? '')); setSelected(shown.map((h) => h.host)); };\n",
        title: 'const f = (h: string): any => { const n = aliasLabel(h); return <span title={n}>{n}</span>; };\n',
        raw: "const f = (h: string): void => { const params = new URLSearchParams(); params.set('host', h); navigate(h);"
            + ' setHosts([h]); };\n',
        callback: 'const f = (h: string): any => { const go = useCallback(() => navigate(h), [h]); const t = aliasLabel(h);'
            + ' return <b onClick={go}>{t}</b>; };\n',
    };
    const missed = Object.keys(Q6_LEAK).filter((k) => nameFlowLeaks([{ name: `/q6known/${k}.tsx`, text: Q6_LEAK[k] }]).length === 0);
    check('Q6 the known leaks are found (M10 first)', missed.length === 0, `not found: ${show(missed)}`);
    const flagged = Object.keys(Q6_SAFE).filter((k) => nameFlowLeaks([{ name: `/q6known/${k}.tsx`, text: Q6_SAFE[k] }]).length !== 0);
    check('Q6 the known safe cases are not flagged (two `host` variables in two functions stay two)', flagged.length === 0,
        `flagged: ${show(flagged)}`);

    // Q7 the Host filter (both pickers draw HostMenu): the search box finds the name and shows when names exist,
    // the button reads the name of one picked host, a tick and the tooltip keep the raw host.
    const picker = read(path.join(HOME, 'components/SidHostPicker.tsx'));
    check('Q7 the menu search matches the name as well', /options\.filter\(\(h\) => matches\(filter, h\.host, describeHost\(h\), resolve\(h\.host\) \?\? ''\)\)/
        .test(picker), 'matches(filter, h.host, describeHost(h), resolve(h.host) ?? \'\')');
    check('Q7 the search box shows whenever names exist', /\{\(options\.length > 8 \|\| hasAliases\) && \(/.test(picker), '(options.length > 8 || hasAliases)');
    check('Q7 the button reads the name of one picked host', /const label = hostButtonLabel\(picked, resolve\);/.test(picker)
        && /if \(picked\.length === 1\) \{\s*return resolve\(picked\[0\]\) \?\? picked\[0\];/.test(picker), 'hostButtonLabel(picked, resolve)');
    check('Q7 a tick toggles the raw host', /onClick=\{toggle\(h\.host\)\}/.test(picker)
        && /const toggle = \(host: string\) => \(\) => \{\s*onChange\(picked\.indexOf\(host\) === -1 \? picked\.concat\(host\) : picked\.filter\(\(h\) => h !== host\)\);/
            .test(picker), 'toggle(h.host) must hand onChange the raw hosts');
    check('Q7 the button tooltips list the raw picked hosts', /\(\$\{pickedHostList\(selection\.hosts\)\}\)/.test(picker)
        && /\(\$\{pickedHostList\(picked\)\}\)/.test(picker) && /const head = picked\.slice\(0, TITLE_HOSTS_MAX\)\.join\(', '\);/.test(picker),
        'pickedHostList(raw hosts) in both tooltips');
    check('Q7 the tooltips list the raw hosts only while names exist; with none they read as before build 400',
        (picker.match(/const \{ hasAliases \} = useHostAlias\(\);/g) || []).length === 2
        && /const hostList = hasAliases \? ` \(\$\{pickedHostList\(selection\.hosts\)\}\)` : '';/.test(picker)
        && /const hostList = hasAliases \? ` \(\$\{pickedHostList\(picked\)\}\)` : '';/.test(picker)
        && /`Filtering to \$\{plural\(selection\.hosts\.length, 'host'\)\}\$\{hostList\} \u2014 click to change`/.test(picker)
        && /`Filtering this dashboard to \$\{plural\(picked\.length, 'host'\)\}\$\{hostList\} \u2014 click to change`/.test(picker),
        'in both pickers hostList is the picked-host list only while hasAliases, else empty; each title ends with hostList,'
        + ' then the dash');

    // Q8 Linux "Top Drop Source": the SPL stays as it is in both arms and the browser splits "<ip> (N,NNN)".
    const linux = dash('Linux.tsx');
    const DISPLAY_SPL = '| eval display = fw_src . " (" . tostring(drops, "commas") . ")" | table display';
    check('Q8 both arms build "<ip> (N,NNN)" as before (the format the browser parses)',
        linux.split(DISPLAY_SPL).length - 1 === 2, 'kpiTopDropSrc in Q and QRAW must end with the display eval');
    const reText = /const TOP_DROP_SRC_RE = \/(.+)\/;\n/.exec(linux);
    check('Q8 the pattern is pinned', reText !== null && reText[1] === '^(\\S+) \\(([0-9,]+)\\)$', reText ? reText[1] : 'missing');
    if (reText !== null) {
        const re = new RegExp(reText[1]);
        const parts = (v: string): string => {
            const m = re.exec(v);
            return m ? `${m[1]}|${m[2]}` : 'none';
        };
        const CASES: Array<[string, string]> = [
            ['192.0.2.10 (1,234)', '192.0.2.10|1,234'],
            ['2001:db8::1 (7)', '2001:db8::1|7'],
            ['app01.example.com (12)', 'app01.example.com|12'],
            ['(none)', 'none'],
            ['', 'none'],
            ['192.0.2.10  (1)', 'none'],
            ['a b (1)', 'none'],
            ['192.0.2.10 (1.5)', 'none'],
            ['192.0.2.10 (12) x', 'none'],
        ];
        const wrong = CASES.filter(([v, want]) => parts(v) !== want).map(([v]) => `${v} -> ${parts(v)}`);
        check('Q8 the pattern splits the SPL value and refuses anything else', wrong.length === 0, show(wrong));
    }
    check('Q8 the card\'s value stays the raw string; the name only through formatValue, the count through valueSuffix,'
        + ' the IP in the sub line',
        /value=\{topDropSrc\.value\}/.test(linux)
        && /formatValue=\{\s*topDropParts && topDropAlias !== null\s*\? \(\): string => topDropAlias\s*: undefined\s*\}/.test(linux)
        && /useFirstRowFieldHybrid\(Q\.kpiTopDropSrc, QRAW\.kpiTopDropSrc, 'display'\)/.test(linux), 'value={topDropSrc.value}');
    check('Q8 the card cuts the name to one line and keeps " (N,NNN)" in view, with "name - ip (N,NNN)" as its title,'
        + ' only when the IP has a name',
        /truncateValue=\{topDropParts !== null && topDropAlias !== null\}/.test(linux)
        && /valueSuffix=\{\s*topDropParts && topDropAlias !== null\s*\? ` \(\$\{topDropParts\.count\}\)`\s*: undefined\s*\}/.test(linux)
        && /valueTitle=\{\s*topDropParts && topDropAlias !== null\s*\? `\$\{topDropAlias\} - \$\{topDropParts\.ip\} \(\$\{topDropParts\.count\}\)`\s*: undefined\s*\}/
            .test(linux), 'truncateValue / valueSuffix / valueTitle gated on topDropParts && topDropAlias !== null');
    const kpi = read(path.join(HOME, 'components/KpiCard.tsx'));
    const kpiValue = /const Value = styled\.div<[^>]*>`([^`]*)`;/.exec(kpi);
    check('Q8 KpiCard opt-ins - truncation, the suffix and the value title; without them the card draws the same Value'
        + ' as before',
        /truncateValue = false,/.test(kpi)
        && !!kpiValue && !/white-space|overflow|text-overflow|display/.test(kpiValue[1])
        && /const TruncatedValue = styled\(Value\)`\s*white-space: nowrap;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*`;/.test(kpi)
        && /\{truncateValue \? \(\s*<TruncatedBox \$tone=\{tone\} \$loading=\{loading\} title=\{loading \|\| error \? undefined : valueTitle\}>\s*\{split \? \(\s*<>\s*<ValueText>\{displayValue\}<\/ValueText>\s*<ValueSuffix>\{valueSuffix\}<\/ValueSuffix>\s*<\/>\s*\) : \(\s*displayValue\s*\)\}\s*<\/TruncatedBox>\s*\) : \(\s*<Value \$tone=\{tone\} \$loading=\{loading\} title=\{loading \|\| error \? undefined : valueTitle\}>\s*\{displayValue\}\s*<\/Value>\s*\)\}/
            .test(kpi), 'Value keeps no truncation CSS; TruncatedBox only under truncateValue;'
            + ' title={loading || error ? undefined : valueTitle} on both');
    const cssOfKpi = (name: string): string => {
        const m = new RegExp(`const ${name} = styled\\.span\`([^\`]*)\``).exec(kpi);
        return m ? m[1] : '';
    };
    const valueTextCss = cssOfKpi('ValueText');
    const valueSuffixCss = cssOfKpi('ValueSuffix');
    check('Q8 KpiCard split - a suffix splits the value only with truncateValue and never while loading or on an error; the text'
        + ' gives way with an ellipsis, the suffix never shrinks',
        /const split = truncateValue && valueSuffix !== undefined && !loading && !error;/.test(kpi)
        && /const TruncatedBox = split \? SplitValue : TruncatedValue;/.test(kpi)
        && /const SplitValue = styled\(TruncatedValue\)`\s*display: flex;\s*align-items: baseline;\s*`;/.test(kpi)
        && /flex: 0 1 auto;/.test(valueTextCss) && /min-width: 0;/.test(valueTextCss) && /overflow: hidden;/.test(valueTextCss)
        && /text-overflow: ellipsis;/.test(valueTextCss) && /white-space: nowrap;/.test(valueTextCss)
        && /flex: 0 0 auto;/.test(valueSuffixCss) && /white-space: pre;/.test(valueSuffixCss)
        && !/overflow|min-width|max-width|flex-shrink: [1-9]/.test(valueSuffixCss),
        `ValueText: ${valueTextCss} ValueSuffix: ${valueSuffixCss}`);
    const kpiOptIns = ALL.filter((p: string) => rel(p) !== 'components/KpiCard.tsx'
        && /\b(truncateValue|valueTitle|valueSuffix)\b/.test(read(p))).map(rel);
    check('Q8 only Linux opts a KPI value into truncation, a suffix and a title', same(kpiOptIns, ['dashboards/Linux.tsx']),
        show(kpiOptIns));

    // Q9 the names stay out of the AI Assistant, the Data Doctor, Open in Search / Inspect / CSV download, the URL
    // builders and the query filters, and out of every search: who imports the alias modules, and who names the table.
    const IMPORT_RE = /from '[^']*\/(HostAliasProvider|hostAlias|hostAliasApi|hostAliasEditor|HostName|HostAliasPanel|NodeAliasContext|nodeAlias|aliasSeries)'/;
    const importers = ALL.filter((p: string) => IMPORT_RE.test(read(p))).map(rel);
    const RAW_ONLY = /^(components\/ai\/|hooks\/useAIAssistant\.ts$|utils\/diag|utils\/panelDiagnosis\.ts$|state\/Diagnostic|dashboards\/Diagnostics\.tsx$|components\/PanelMeta\.tsx$|utils\/drilldownUrls\.ts$|utils\/searchPage\.ts$|utils\/queryFilters\.ts$)/;
    const rawOnlyImporters = importers.filter((f: string) => RAW_ONLY.test(f));
    check('Q9 the AI Assistant, the Data Doctor, PanelMeta, the URL builders and the query filters import no alias module',
        rawOnlyImporters.length === 0, show(rawOnlyImporters));
    check('Q9 the files that import an alias module (a new one is a reviewed change)', same(importers, [
        'components/AppShell.tsx',
        'components/DataTable.tsx',
        'components/HostAliasPanel.tsx',
        'components/HostName.tsx',
        'components/SidHostPicker.tsx',
        'components/TimeSeriesChart.tsx',
        'components/topology/NodeAliasContext.ts',
        'components/topology/TopologyBottomPanel.tsx',
        'components/topology/TopologyRightSidebar.tsx',
        'components/topology/nodeTypes/PartnerNode.tsx',
        'dashboards/AIAssistantSettings.tsx',
        'dashboards/DataPipelineOverview.tsx',
        'dashboards/DnsAnalytics.tsx',
        'dashboards/HostDetails.tsx',
        'dashboards/IntegrationTopology.tsx',
        'dashboards/Linux.tsx',
        'state/HostAliasProvider.tsx',
        'utils/hostAliasApi.ts',
        'utils/hostAliasEditor.ts',
    ]), show(importers));
    const TABLE_FILES = ['components/HostAliasPanel.tsx', 'utils/fieldClassification.ts', 'utils/hostAlias.ts', 'utils/hostAliasApi.ts',
        'utils/hostAliasEditor.ts'];
    const namers = ALL.map(rel).filter((f: string) => TABLE_FILES.indexOf(f) === -1
        && /logserv_host_aliases|\bmatch_value\b/.test(read(path.join(HOME, f))));
    check('Q9 no dashboard, hook, route, topology or search file names the table or its match_value field', namers.length === 0,
        show(namers));

    // Q10 (T3) a host name needs no import to reach a table: DataTable resolves a flagged column itself, so a
    // `hostAlias: true` column in the AI Assistant's result table would show names with no alias module imported. In the
    // files that must stay raw, no code (comments are not code) sets a hostAlias flag, names aliasSeries or calls
    // useHostAlias, and none imports an alias module (Q9). Outside the dashboards only DataTable reads the flag and only
    // TimeSeriesChart takes aliasSeries.
    const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const FLAG_RE = /\bhostAlias\s*[:=]|\baliasSeries\b|\buseHostAlias\b|\buseNodeAlias\b/;
    const rawOnly = ALL.filter((p: string) => RAW_ONLY.test(rel(p)));
    const flaggedRaw = rawOnly.filter((p: string) => FLAG_RE.test(stripComments(read(p))) || IMPORT_RE.test(read(p))).map(rel);
    check('Q10 the AI Assistant, the Data Doctor, PanelMeta, the URL builders and the query filters set no hostAlias flag, name no'
        + ' aliasSeries and call no alias hook', flaggedRaw.length === 0 && rawOnly.length >= 40, `${show(flaggedRaw)} (${rawOnly.length} files)`);
    const flagUsers = ALL.filter((p: string) => !/^dashboards\//.test(rel(p)) && /\bhostAlias\s*[:=]/.test(stripComments(read(p)))).map(rel);
    check('Q10 outside the dashboards no file sets a hostAlias flag on a column', flagUsers.length === 0, show(flagUsers));
    const seriesUsers = ALL.filter((p: string) => !/^dashboards\//.test(rel(p)) && /\baliasSeries\b/.test(stripComments(read(p)))).map(rel);
    check('Q10 outside the dashboards only TimeSeriesChart names aliasSeries in code (its helper module only in comments)', same(seriesUsers,
        ['components/TimeSeriesChart.tsx']), show(seriesUsers));
    const KNOWN_FLAGS = ['return order.map((key) => ({ key, label: key, hostAlias: true }));',
        'return order.map((key) => ({ key, label: key, hostAlias: /host|ip/i.test(key) }));', '<DataTable hostAlias={true} />',
        'const col = { key: k, hostAlias: flag };', '<TimeSeriesChart aliasSeries />', 'const { resolve } = useHostAlias();'];
    check('Q10 the flag forms are caught (the audit\'s ToolResultPanel mutants among them)', KNOWN_FLAGS.every((s) => FLAG_RE.test(s))
        && !FLAG_RE.test('const hostAliases = 1; col.hostAlias && x;'), show(KNOWN_FLAGS.filter((s) => !FLAG_RE.test(s))));
}

if (haFailures > 0) {
    process.stderr.write(`hostAlias.consistency-test: ${haFailures} of ${haChecks} checks FAILED\n`);
    process.exit(1);
}
console.log(`hostAlias.consistency-test: ${haChecks} checks passed`);
