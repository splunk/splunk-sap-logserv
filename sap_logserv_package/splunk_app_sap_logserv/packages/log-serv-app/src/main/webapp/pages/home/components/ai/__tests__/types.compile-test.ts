/**
 * Compile-time type-system tests for the AI module.
 *
 * These are NOT runtime tests. The whole point is that some lines below
 * are commented out with `// @ts-expect-error` — if the TypeScript
 * compiler ever STOPS rejecting them, that's the bug. Conversely, if
 * a non-error line ever fails to compile, the surrounding refactor
 * regressed the type system.
 *
 * Run with: `cd packages/log-serv-app && yarn types:build` — the build
 * passes if and only if every assertion below holds.
 */

import {
    Hidden,
    markHidden,
    Visible,
    markVisible,
    sanitize,
    Message,
    systemMessage,
    userMessage,
    assistantMessage,
    SearchResult,
    toolResultOk,
    IsHidden,
    IsVisible,
} from '../types';
import { buildOutboundPayload } from '../providers';

// -----------------------------------------------------------------------------
// 1. Hidden and Visible are nominally distinct (no implicit widening)
// -----------------------------------------------------------------------------

const _hiddenStr: Hidden<string> = markHidden('secret');
const _visibleStr: Visible<string> = markVisible('safe');

// @ts-expect-error — Hidden<string> is NOT assignable to Visible<string>
const _bad1: Visible<string> = _hiddenStr;

// @ts-expect-error — Visible<string> is NOT assignable to Hidden<string>
const _bad2: Hidden<string> = _visibleStr;

// IsHidden / IsVisible type-level helpers behave correctly
type _T1 = IsHidden<Hidden<string>>; // = true
type _T2 = IsHidden<Visible<string>>; // = false
type _T3 = IsVisible<Visible<string>>; // = true
type _T4 = IsVisible<Hidden<string>>; // = false

const _t1: _T1 = true;
const _t2: _T2 = false;
const _t3: _T3 = true;
const _t4: _T4 = false;

// -----------------------------------------------------------------------------
// 2. Hidden values cannot be smuggled into Message
// -----------------------------------------------------------------------------

const _userMsgOk: Message = userMessage(markVisible('What hosts are slowest?'));

// @ts-expect-error — userMessage requires Visible<string>, not Hidden<string>
const _userMsgBad: Message = userMessage(markHidden('raw splunk row content'));

const _msgManualBad: Message = {
    role: 'user',
    // @ts-expect-error — content field is Visible<string>; cannot assign Hidden<string>
    content: markHidden('row content'),
};

// -----------------------------------------------------------------------------
// 3. The only way Hidden becomes Visible is through sanitize()
// -----------------------------------------------------------------------------

const splunkResult: Hidden<SearchResult> = markHidden({
    rows: [{ host: 'foo', count: 14 }],
    totalRowCount: 1,
    executionMs: 230,
    spl: 'index=foo',
});

// sanitize() forces the caller to derive a non-data summary.
const summary: Visible<string> = sanitize(splunkResult, (r) =>
    `Returned ${r.totalRowCount} row(s) in ${r.executionMs}ms`,
);

// The summary is now safely usable in a Message.
const _assistantMsg: Message = assistantMessage(summary);

// -----------------------------------------------------------------------------
// 4. buildOutboundPayload accepts Message[] but not raw objects with Hidden fields
// -----------------------------------------------------------------------------

const _okPayload = buildOutboundPayload(
    [systemMessage('You are a SPL assistant.'), userMessage(markVisible('show errors'))],
    [],
);

const _badPayload = buildOutboundPayload(
    // @ts-expect-error — content is plain string, not Visible<string>; rejected
    [{ role: 'user', content: 'show errors' }],
    [],
);

// -----------------------------------------------------------------------------
// 5. ToolResult wrapping marks payloads as Hidden
// -----------------------------------------------------------------------------

const result = toolResultOk({ rows: [], totalRowCount: 0, executionMs: 5, spl: '' });
if (result.ok) {
    // @ts-expect-error — result.value is Hidden<SearchResult>; cannot widen
    const _leak: Visible<SearchResult> = result.value;
}

// -----------------------------------------------------------------------------
// All assertions above either compile correctly (positive cases) or are
// marked with `@ts-expect-error` and would fail to compile if the type
// system was broken (negative cases). If `tsc --noEmit` succeeds on this
// file, the privacy type system is intact.
// -----------------------------------------------------------------------------

export {};
