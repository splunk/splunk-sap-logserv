/**
 * Build-time consistency test for the AI Assistant's two legal acknowledgements (build 386, session 161).
 *
 * Each acknowledgement shows a fixed text and records, on its audit event, the SHA-256 of that text (`disclaimerHash`)
 * and the acknowledged version (`tcVersion`). A deployment is asked again only when the version in
 * default/ai_assistant_acks.conf rises, so a change to the wording without a version bump would leave existing
 * acknowledgements standing for words nobody acknowledged. Build 386 corrected the forwarder-disabled text (it named the
 * audit index `ai_assistant_audit`) and moved `[logserv-ai-assistant-tc] optInVersion` from 1 to 2. Build 387 corrected
 * clause 7 of the enablement text (it said the answer is recorded "via the standard Splunk telemetry endpoint") and
 * moved `[logserv-ai-assistant-enable-tc] optInVersion` from 1 to 2. Build 388 corrected its closing sentence (a No
 * now turns an enabled AI Assistant off) and moved it to 3.
 *
 * What it pins:
 *  L1 each text is a static template literal (no `${...}`, no escapes), so the hash below is the one the browser
 *     computes (TextEncoder UTF-8, SHA-256, lowercase hex - sha256Hex in each modal);
 *  L2 each text's SHA-256 equals the LAST entry of its revision history, and the stanza's optInVersion equals that
 *     entry's version; the history's versions rise strictly and its hashes are distinct - so a new wording needs a new
 *     history entry with a higher version, and the conf has to follow;
 *  L3 the forwarder-disabled text names the audit index as `logserv_ai_assistant_audit` (or the one set in Settings)
 *     and never by the old bare name `ai_assistant_audit`;
 *  L4 each modal hashes and renders the same constant;
 *  L5 neither modal nor the Settings page says an answer is recorded through "the standard Splunk telemetry
 *     endpoint" (an answer is an audit-log event, since builds 99 and 100, and since build 240 a KV Store row),
 *     in the legal texts or around them;
 *  L6 the enablement text's closing sentence says a No disables an AI Assistant that is already enabled, and the
 *     code is wired to do so: in AIAssistantSettings.tsx handleEnableChoice the turn-off branch and its write come
 *     before the No is recorded, a failed turn-off returns without recording, setSaved / setDraft follow the write,
 *     and the No branch returns before the Yes path; the dialog's re-ask sentence and its No button carry the same
 *     condition. Since build 389 they also pin that the turn-off writes the page's settings whole (never a
 *     partial, which would merge onto a read that can fall back to the defaults), that the dialog closes before
 *     the page state changes, that an answer which cannot be recorded closes the dialog and returns before the
 *     audit event and the save, and that a recorded answer closes it before the No message or the save; since
 *     build 390, that a turn-off keeps the page busy until its No is recorded and that a No records the
 *     provider in effect; since build 391, that the turn-off sets the page busy before its write and releases it
 *     when the write fails, that nothing sets or releases it between the write and the record, and that the
 *     dialog names the provider in effect on a re-ask; since build 392, that it also names the one a Yes would
 *     save when the same save changes it, and that the write's catch releases the busy state and sets nothing
 *     else;
 *  L7 (build 390) the forwarder dialog closes before it shows an error recording its answer, its No records the
 *     provider in effect, and a failed save closes both dialogs before it shows the error; (build 391) its audit
 *     event records the answer given and is posted for either answer as soon as the answer is recorded, before
 *     the save a Yes goes on to, and it is built nowhere else (actuallySave takes no acceptance);
 *  L8 (build 392) each acknowledgement event has exactly its fields, is posted once, and its category appears
 *     once in the page; each answer is recorded once, awaited, in its own store, before its event.
 *  Since build 392 the busy, provider and event pins read the code with its comments removed (line and block
 *  comments, outside strings and template literals), so a commented-out copy satisfies none of them. L6 to L8 pin
 *  the code's shape, not its run-time behaviour.
 *
 * Run standalone with: `yarn check:diagnostics`
 */

/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-var-requires */

// Standalone script, not a module.
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: {
    env: { [k: string]: string | undefined };
    stderr: { write(s: string): void };
    exit(code: number): never;
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RES = path.resolve(__dirname, '../../../../resources/splunk');
const ACKS = process.env.LEGALACKS_CONF || path.join(RES, 'default', 'ai_assistant_acks.conf');
const HOME = path.resolve(__dirname, '..');
const FORWARDER = process.env.LEGALACKS_FORWARDER || path.join(HOME, 'components', 'ForwarderDisabledAcceptanceModal.tsx');
const ENABLE = process.env.LEGALACKS_ENABLE || path.join(HOME, 'components', 'AiAssistantEnableAcceptanceModal.tsx');
const SETTINGS = process.env.LEGALACKS_SETTINGS || path.join(HOME, 'dashboards', 'AIAssistantSettings.tsx');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let laFailures = 0;
let laChecks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    laChecks += 1;
    if (!ok) {
        laFailures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};

// Revision history per stanza: append a new entry (higher version, new hash) whenever a text changes, and raise the
// stanza's optInVersion in default/ai_assistant_acks.conf to the same version.
const HISTORY: { [stanza: string]: Array<{ version: number; sha256: string; note: string }> } = {
    'logserv-ai-assistant-tc': [
        { version: 1, sha256: '53a68dbc4201a6915fe58240703203a41357a3295fd4f390169ae74deaf29254', note: 'build 99' },
        { version: 2, sha256: 'ade3a2d9bd54d6c695ac878129955aea7c47dcd54c941d91e66c8f50dc21052e',
            note: 'build 386: the audit index named logserv_ai_assistant_audit (or the one set in Settings)' },
    ],
    'logserv-ai-assistant-enable-tc': [
        { version: 1, sha256: '670b1fbe2783ef39e825e626bf9f1df8cbb7bdf87bf104f94968645865564c47', note: 'build 100' },
        { version: 2, sha256: '4e3c04b30dbebb22138adc23e26b8f4195b6c34e593d90e4bca233393214fd27',
            note: 'build 387: clause 7 says the answer is recorded in the audit log and the KV Store' },
        { version: 3, sha256: '8150e9181a47c1576898dab3da58bc400a4735ac2c0ac82f3f4ad1555d740e74',
            note: 'build 388: a No turns an enabled AI Assistant off, and the closing sentence says so' },
    ],
};
const TEXTS: Array<{ stanza: string; file: string; constant: string }> = [
    { stanza: 'logserv-ai-assistant-tc', file: FORWARDER, constant: 'ACCEPTANCE_DISCLAIMER_TEXT' },
    { stanza: 'logserv-ai-assistant-enable-tc', file: ENABLE, constant: 'ENABLE_DISCLAIMER_TEXT' },
];

const confVersion = (conf: string, stanza: string): number | null => {
    let cur: string | null = null;
    let found: number | null = null;
    conf.split('\n').forEach((raw) => {
        const line = raw.trim();
        const h = /^\[([^\]]+)\]$/.exec(line);
        if (h) {
            cur = h[1];
            return;
        }
        const m = /^optInVersion\s*=\s*(\S*)\s*$/.exec(line);
        if (m && cur === stanza) found = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NaN;
    });
    return found;
};

const conf = read(ACKS);
const texts: { [stanza: string]: string } = {};
TEXTS.forEach(({ stanza, file, constant }) => {
    const src = read(file);
    const m = new RegExp(`export const ${constant} = \`([^\`]*)\`;`).exec(src);
    check(`L1 ${constant} is a static template literal in ${path.basename(file)}`, m !== null, 'not found');
    if (!m) return;
    const text = m[1];
    texts[stanza] = text;
    check(`L1 ${constant} has no interpolation and no escapes`, text.indexOf('${') === -1 && text.indexOf('\\') === -1,
        'the hash below would not be the one the browser computes');
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const hist = HISTORY[stanza];
    const last = hist[hist.length - 1];
    check(`L2 ${constant} matches the last revision of [${stanza}] (version ${last.version})`, sha === last.sha256,
        `sha256 ${sha} - a changed text needs a new HISTORY entry with a higher version and the same optInVersion`);
    const v = confVersion(conf, stanza);
    check(`L2 [${stanza}] optInVersion equals the last revision's version`, v === last.version,
        `conf ${v}, history ${last.version}`);
    const versions = hist.map((h) => h.version);
    check(`L2 [${stanza}] revision versions rise strictly`,
        versions.every((x, i) => i === 0 || x > versions[i - 1]), JSON.stringify(versions));
    check(`L2 [${stanza}] revision hashes are distinct`, new Set(hist.map((h) => h.sha256)).size === hist.length,
        'a repeated hash');
    check(`L4 ${path.basename(file)} hashes and renders ${constant}`,
        src.indexOf(`sha256Hex(${constant})`) !== -1 && new RegExp(`\\{${constant}\\}`).test(src),
        'the hashed text and the shown text could differ');
});

const fw = texts['logserv-ai-assistant-tc'] || '';
check('L3 the forwarder-disabled text names logserv_ai_assistant_audit',
    fw.indexOf('logserv_ai_assistant_audit') !== -1, 'not named');
check('L3 the forwarder-disabled text never uses the old bare index name',
    !/(^|[^A-Za-z0-9_])ai_assistant_audit/.test(fw), 'the old name is back');

[FORWARDER, ENABLE, SETTINGS].forEach((file) => {
    const n = (read(file).match(/telemetry\s+endpoint/gi) || []).length;
    check(`L5 ${path.basename(file)} never says an answer goes through the telemetry endpoint`, n === 0,
        `${n} mention(s) - an answer is an audit-log event and, since build 240, a KV Store row`);
});

// The code with its comments removed (build 392): line comments and block comments outside string and template
// literals go, line breaks stay, so line-anchored pins still see lines. Regex literals and JSX text are not
// recognised; the slices this reads (the two answer handlers and the dialog's tag) have neither.
const codeOf = (src: string): string => {
    let out = '';
    let mode = 'code';
    const substitutions: number[] = [];
    let depth = 0;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const d = src[i + 1];
        if (mode === 'code') {
            if (c === '/' && d === '/') {
                const j = src.indexOf('\n', i);
                i = j === -1 ? src.length : j;
            } else if (c === '/' && d === '*') {
                const j = src.indexOf('*/', i + 2);
                const end = j === -1 ? src.length : j + 2;
                out += src.slice(i, end).replace(/[^\n]/g, '');
                i = end;
            } else {
                if (c === "'" || c === '"' || c === '`') {
                    mode = c;
                } else if (c === '{') {
                    depth += 1;
                } else if (c === '}') {
                    if (substitutions.length > 0 && substitutions[substitutions.length - 1] === depth) {
                        substitutions.pop();
                        mode = '`';
                    } else {
                        depth -= 1;
                    }
                }
                out += c;
                i += 1;
            }
        } else if (c === '\\') {
            out += src.slice(i, i + 2);
            i += 2;
        } else if (c === mode) {
            mode = 'code';
            out += c;
            i += 1;
        } else if (mode === '`' && c === '$' && d === '{') {
            substitutions.push(depth);
            mode = 'code';
            out += src.slice(i, i + 2);
            i += 2;
        } else {
            out += c;
            i += 1;
        }
    }
    return out;
};
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

const en = texts['logserv-ai-assistant-enable-tc'] || '';
check('L6 the enablement text says a No disables an AI Assistant that is already enabled',
    en.indexOf('if it is already enabled, be disabled') !== -1, 'the closing sentence no longer says so');
const settingsSrc = read(SETTINGS);
const hs = settingsSrc.indexOf('const handleEnableChoice = async (');
const he = hs === -1 ? -1 : settingsSrc.indexOf('const handleForwarderChoice = async (', hs);
const enableBody = hs === -1 || he === -1 ? '' : settingsSrc.slice(hs, he);
const iOff = enableBody.indexOf('await writeAIConfig(off)');
const iAck = enableBody.indexOf('await writeTcAcknowledgement(STANZA_ENABLE_TC');
const iIf = enableBody.indexOf('        if (turnOff) {\n            const off: AIConfigSettings = { ...saved, enabled: false };');
check('L6 handleEnableChoice turns an enabled AI Assistant off on a No, before it records the No',
    /const turnOff = choice === 'no' && saved\.enabled;/.test(enableBody)
    && iIf !== -1 && iOff !== -1 && iAck !== -1 && iIf < iOff && iOff < iAck,
    `turnOff ${/const turnOff = /.test(enableBody)}, branch at ${iIf}, write at ${iOff}, record at ${iAck}`);
check('L6 the turn-off writes the page settings whole, never a partial merged onto a fresh read',
    !/writeAIConfig\(\{/.test(enableBody) && enableBody.indexOf('clearAIConfigCache') === -1,
    'a partial merges onto readAIConfig(), which falls back to the conf or the defaults on a failed KV read');
check('L6 a failed turn-off records nothing (its catch returns); a done one closes the dialog, then updates the page',
    /await writeAIConfig\(off\);\n\s*\} catch \(e\) \{[\s\S]*?Nothing was recorded[\s\S]*?\n\s*return;\n\s*\}\n(?:\s*\/\/[^\n]*\n)*\s*setEnableModalOpen\(false\);\n\s*setSaved\(off\);\n\s*setDraft\(off\);/
        .test(enableBody),
    'the failure catch must end in return; setEnableModalOpen(false), then setSaved(off) and setDraft(off), '
    + 'must follow the write');
check('L6 an answer that cannot be recorded closes the dialog, shows the error and stops there',
    /\} catch \(e\) \{\n(?:\s*\/\/[^\n]*\n)*\s*setEnableModalOpen\(false\);\n\s*setOpError\(\n\s*`\$\{turnOff \?[\s\S]*?\n\s*\);\n\s*return;\n\s*\} finally \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(turnOff\) \{\n\s*setBusy\(false\);\n\s*\}\n\s*\}\n\n\s*\/\/ Fire the audit event for both yes and no\./
        .test(enableBody),
    'the record-failure catch must close the dialog, show the error and return before the audit event and the save, '
    + 'and a finally must end the turn-off\'s busy state');
check('L6 a recorded answer closes the dialog before the No message or the save',
    /void AuditWriter\.postOneOff\(acceptanceEvent\);\n\n\s*setEnableModalOpen\(false\);\n\n\s*if \(choice === 'no'\) \{/
        .test(enableBody),
    'setEnableModalOpen(false) must follow the audit event and come before the No branch');
check('L6 a declined save does not go on (the No branch returns)',
    /if \(choice === 'no'\) \{\n\s*setOpError\(\n\s*turnOff\n[\s\S]*?\n {12}\);\n {12}return;\n {8}\}\n\n {8}\/\/ 'yes' . chain to the forwarder modal/
        .test(enableBody),
    'the No branch must end in return before the Yes path');
// The handler's code without comments (build 392): the busy, provider and event pins below read it.
const enableCode = codeOf(enableBody);
// Build 391: the busy window starts where the turn-off write's catch returns (that catch is the failure path, which
// releases the busy state and returns), so a release anywhere after it - a finally on the write, or a line before
// setSaved(off) - fails; the busy state must also be set right before the write, and (build 392) the catch must
// release it and set nothing else.
const iOffC = enableCode.indexOf('await writeAIConfig(off)');
const iAckC = enableCode.indexOf('await writeTcAcknowledgement(STANZA_ENABLE_TC');
const iWc = iOffC === -1 ? -1 : enableCode.indexOf('} catch (e) {', iOffC);
const iWr = iWc === -1 ? -1 : enableCode.indexOf('return;', iWc);
const writeCatch = iWc === -1 || iWr === -1 ? '' : enableCode.slice(iWc, iWr);
check('L6 a turn-off sets the page busy before it writes',
    /const off: AIConfigSettings = \{ \.\.\.saved, enabled: false \};\s*setBusy\(true\);\s*try \{\s*await writeAIConfig\(off\);/
        .test(enableCode),
    'setBusy(true) must come right before the turn-off write');
check('L6 a failed turn-off releases the busy state before it returns, and sets nothing else',
    count(writeCatch, /setBusy\(/g) === 1 && /\n\s*setBusy\(false\);\n/.test(writeCatch),
    'the write catch must call setBusy(false), once and alone; without it the Save button stays at "Saving…"');
check('L6 a turn-off keeps the page busy until its No is recorded',
    iWr !== -1 && iAckC > iWr && enableCode.slice(iWr, iAckC).indexOf('setBusy(') === -1,
    'nothing may set or release the busy state between the turn-off write and the record');
const modalTag = /<AiAssistantEnableAcceptanceModal\b[\s\S]*?\/>/.exec(settingsSrc);
const modalCode = modalTag ? codeOf(modalTag[0]) : '';
check('L6 on a re-ask the enablement dialog names the provider in effect',
    /^\s*providerName=\{saved\.enabled \? saved\.provider : draft\.provider\}$/m.test(modalCode),
    'the dialog must name saved.provider while the AI Assistant is on');
check('L6 and, when the same save changes the provider, the one a Yes saves',
    /^\s*pendingProviderName=\{saved\.enabled && draft\.provider !== saved\.provider \? draft\.provider : undefined\}$/m
        .test(modalCode),
    'the dialog must also name draft.provider on a re-ask whose save changes it, and nothing otherwise');
const fs0 = settingsSrc.indexOf('const handleForwarderChoice = async (');
const fe0 = fs0 === -1 ? -1 : settingsSrc.indexOf('const handleRevert = (): void =>', fs0);
const forwarderBody = fs0 === -1 || fe0 === -1 ? '' : settingsSrc.slice(fs0, fe0);
check('L7 the forwarder dialog closes before it shows an error recording the answer',
    /\} catch \(e\) \{\n(?:\s*\/\/[^\n]*\n)*\s*setForwarderModalOpen\(false\);\n\s*setOpError\(\n\s*`Failed to record the acknowledgement in the KV Store: /
        .test(forwarderBody),
    'the record-failure catch must close the forwarder dialog before the error');
const forwarderCode = codeOf(forwarderBody);
// Each event's own lines, read alone (setForwarderTcState above the forwarder event also has `optInChoice: choice,`).
const eventLines = (code: string, type: string): string[] => {
    const start = code.indexOf(`const acceptanceEvent: ${type} = {`);
    const tail = start === -1 ? null : /\n\s*\};\n/.exec(code.slice(start));
    if (start === -1 || tail === null) {
        return [];
    }
    return code.slice(start, start + tail.index).split('\n').slice(1).map((l) => l.trim())
        .filter((l) => l.length > 0);
};
const enableEvent = eventLines(enableCode, 'AiAssistantEnableAcceptanceEvent');
const forwarderEvent = eventLines(forwarderCode, 'ForwarderDisabledAcceptanceEvent');
const PROVIDER_LINE = "provider: choice === 'yes' ? draft.provider : saved.provider,";
check('L6 a No on the enablement dialog records the provider in effect', enableEvent.indexOf(PROVIDER_LINE) !== -1,
    'the event must record saved.provider for a No');
check('L7 a No on the forwarder dialog records the provider in effect', forwarderEvent.indexOf(PROVIDER_LINE) !== -1,
    'the event must record saved.provider for a No');
check('L7 the forwarder event records the answer given', forwarderEvent.indexOf('optInChoice: choice,') !== -1,
    'the event\'s optInChoice must be the answer, for a Yes and for a No');
// L8 (build 392): exactly these fields, in this order - a changed value, a dropped or an added field fails.
const eventFields = (category: string, previous: string): string[] => [
    'timestamp: new Date().toISOString(),',
    "user: adminUsername || 'unknown',",
    ['sessionId: `settings-', '{Date.now().toString(36)}`,'].join('$'),
    'seq: 1,',
    `category: '${category}',`,
    'acceptedAt: new Date().toISOString(),',
    'disclaimerHash,',
    PROVIDER_LINE,
    `previousEnabledState: ${previous},`,
    'tcVersion: versionAtChoice,',
    'optInChoice: choice,',
];
check('L8 the enablement event has exactly its fields',
    JSON.stringify(enableEvent) === JSON.stringify(eventFields('ai_assistant_enable_acceptance', 'saved.enabled')),
    JSON.stringify(enableEvent));
check('L8 the forwarder event has exactly its fields',
    JSON.stringify(forwarderEvent)
        === JSON.stringify(eventFields('forwarder_disabled_acceptance', 'saved.audit_forwarder_enabled')),
    JSON.stringify(forwarderEvent));
const POSTED = /AuditWriter\.postOneOff\(acceptanceEvent\)/g;
check('L8 each acknowledgement event is posted once',
    count(enableCode, POSTED) === 1 && count(forwarderCode, POSTED) === 1,
    `enablement ${count(enableCode, POSTED)}, forwarder ${count(forwarderCode, POSTED)}`);
check('L8 each acknowledgement category appears once in the page',
    count(settingsSrc, /forwarder_disabled_acceptance/g) === 1
    && count(settingsSrc, /ai_assistant_enable_acceptance/g) === 1,
    'another event of an acknowledgement category, or a mention of one, is in AIAssistantSettings.tsx');
check('L8 each answer is recorded once, awaited, in its own store, before its event',
    count(enableCode, /writeTcAcknowledgement\(/g) === 1
    && enableCode.indexOf('await writeTcAcknowledgement(STANZA_ENABLE_TC, choice, versionAtChoice);') !== -1
    && iAckC < enableCode.indexOf(': AiAssistantEnableAcceptanceEvent = {')
    && count(forwarderCode, /writeTcAcknowledgement\(/g) === 1
    && forwarderCode.indexOf('await writeTcAcknowledgement(STANZA_FORWARDER_TC, choice, versionAtChoice);') !== -1
    && forwarderCode.indexOf('await writeTcAcknowledgement(')
        < forwarderCode.indexOf(': ForwarderDisabledAcceptanceEvent = {'),
    'each handler must await writeTcAcknowledgement(<its stanza>, choice, versionAtChoice) once, before its event');
check('L7 the forwarder event is posted as soon as the answer is recorded, before the save a Yes goes on to',
    /\n\s*return;\n\s*\}\n\n(?:\s*\/\/[^\n]*\n)*\s*const acceptanceEvent: ForwarderDisabledAcceptanceEvent = \{\n[\s\S]*?\n\s*\};\n\s*void AuditWriter\.postOneOff\(acceptanceEvent\);\n\n\s*if \(choice === 'yes'\) \{\n\s*await actuallySave\(\);\n\s*return;\n\s*\}\n\s*setForwarderModalOpen\(false\);/
        .test(forwarderBody),
    'the event must follow the record (whose catch returns) and come before the Yes save and the No close');
const as0 = settingsSrc.indexOf('const actuallySave = async (');
const ae0 = as0 === -1 ? -1 : settingsSrc.indexOf('const isEnableTcPending = (): boolean =>', as0);
const saveBody = as0 === -1 || ae0 === -1 ? '' : settingsSrc.slice(as0, ae0);
check('L7 a failed save closes both dialogs before it shows the error',
    /\} catch \(e\) \{\n(?:\s*\/\/[^\n]*\n)*\s*setForwarderModalOpen\(false\);\n\s*setEnableModalOpen\(false\);\n\s*setOpError\(e instanceof Error \? e\.message : String\(e\)\);\n\s*\} finally \{/
        .test(saveBody),
    "actuallySave's catch must close the dialogs before the error");
check('L7 the forwarder event is built only in handleForwarderChoice, and actuallySave takes no acceptance',
    (settingsSrc.match(/: ForwarderDisabledAcceptanceEvent = \{/g) || []).length === 1
    && (forwarderBody.match(/: ForwarderDisabledAcceptanceEvent = \{/g) || []).length === 1
    && /const actuallySave = async \(\): Promise<void> => \{/.test(saveBody)
    && saveBody.indexOf('forwarder_disabled_acceptance') === -1,
    'a second forwarder event, or an acceptance parameter on actuallySave, is back');
const enableSrc = read(ENABLE);
check('L6 the enablement dialog labels the No button "record No and turn off" while the AI Assistant is on',
    /\{previousEnabledState\s*\?\s*'I do not accept \(record No and turn off\)'\s*:\s*'I do not accept \(record No\)'\}/
        .test(enableSrc),
    'label missing or its condition changed');
check('L6 the enablement dialog says on the re-ask that a No turns the AI Assistant off',
    /const transitionLabel = previousEnabledState\s*\?\s*'Re-acknowledgement required for the AI Assistant feature\. If you do not accept, the AI Assistant is turned off\.'/
        .test(enableSrc),
    'the re-ask sentence is missing or its condition changed');
check('L6 the enablement dialog shows the provider a Yes would save after the active one',
    /pendingProviderName\?: string;/.test(enableSrc)
    && /Active LLM provider: <code>\{providerName \|\| '\(none configured\)'\}<\/code>\s*\{pendingProviderName \? \(\s*<> \(this save changes it to <code>\{pendingProviderName\}<\/code>\)<\/>\s*\) : null\}\s*\.\s*The disclaimer below applies/
        .test(enableSrc),
    'the provider line must name pendingProviderName, when it is given, right after the active provider');

if (laFailures > 0) {
    process.stderr.write(`\nlegalAcks.consistency-test: ${laFailures} failure(s) of ${laChecks}\n`);
    process.exit(1);
}
console.log(`legalAcks.consistency-test: OK (${laChecks} checks; forwarder-disabled text at version `
    + `${confVersion(conf, 'logserv-ai-assistant-tc')}, enablement text at version `
    + `${confVersion(conf, 'logserv-ai-assistant-enable-tc')})`);
