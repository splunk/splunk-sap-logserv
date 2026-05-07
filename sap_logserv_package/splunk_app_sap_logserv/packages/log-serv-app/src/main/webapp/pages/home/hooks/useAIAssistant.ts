import { useCallback, useEffect, useRef } from 'react';
import { useAIAssistantContext, DisplayMessage } from '../state/AIAssistantProvider';
import {
    toolResultMessage,
} from '../components/ai';
import { LocalOnlyEvent, SecurityBlockedSplEvent, SessionToolCapHitEvent } from '../components/ai/audit/auditTypes';
import { Hidden, markHidden, unwrapHidden } from '../components/ai/types/Hidden';
import { MCPToolResult } from '../components/ai/mcp/MCPClient';
import { detectToolError } from '../utils/mcpErrorDetect';
import { analyzeSpl } from '../utils/splGuard';
import { ChartPalette } from '../styles/chartPalettes';
import intentMap from '../../../../resources/splunk/default/data/mcp/logserv_intent_map.json';

/**
 * useAIAssistant — the high-level state machine for the chat UI.
 *
 * Two entry points:
 *
 *   `runCannedPrompt(...)`
 *     — Fast path. Bypasses the AI vendor entirely. Posts the user
 *     intent to the chat, runs the saved search via MCP, hydrates the
 *     result panel, logs a `local_only` audit event. No outbound to
 *     any vendor.
 *
 *   `sendUserMessage(text)`
 *     — Free-form path. Streams the AI response into the chat. If the
 *     AI requests tool calls, this hook dispatches them via MCP,
 *     records sanitized result summaries, and re-streams so the AI can
 *     continue with the new context. Tool RESULT data NEVER flows back
 *     into the AI's conversation; only sanitized count/timing summaries.
 *
 * Tool-call loop safety: capped at MAX_TOOL_TURNS iterations to prevent
 * runaway AI loops where the model keeps requesting tools without ever
 * emitting an end_turn.
 */

/** Max number of AI turns per user message before the orchestrator gives
 *  up. Each "turn" is one stream + (optionally) one batch of parallel
 *  tool dispatches. Bumped 5 → 8 in build 70 to leave room for
 *  multi-step investigations where Claude alternates between dispatching
 *  tools and narrating intermediate findings. */
export interface UseAIAssistantResult {
    runCannedPrompt: (params: CannedPromptParams) => Promise<void>;
    sendUserMessage: (text: string) => Promise<void>;
    abort: () => void;
}

export interface UseAIAssistantOptions {
    /** When false, the hook does NOT attempt MCP tool dispatches.
     *  Canned prompts still try MCP and will fail — the UI should
     *  hide the prompt browser button in that case. Default: true.
     *
     *  v0.0.5.0 stripped variant: the LLM-driven free-form path is
     *  physically removed from the source. Only the canned-prompt
     *  path is operational; `sendUserMessage` is a stub that emits a
     *  system_notice. The other tier / rate-limit / Power Mode
     *  options that were here in the full LLM build are gone — they
     *  had no consumer in this variant. */
    mcpAvailable?: boolean;
}

export interface CannedPromptParams {
    promptId: string;
    label: string;
    spl: string;
    savedSearchName: string;
    renderHint?: 'table' | 'timechart' | 'kpi' | 'pie';
    /** Optional companion chart for table-primary results. Threaded
     *  through to the tool_result message so ToolResultPanel can render
     *  the chart above the table. */
    chartHint?: 'timechart' | 'kpi' | 'pie';
    /** Optional explicit palette for the chart (volume / errors / auth /
     *  status / categorical). Mirrors the dashboard convention. When
     *  omitted, ToolResultPanel auto-detects from value-field shape.
     *  Build 139. */
    chartPalette?: ChartPalette;
    /** Optional interpretation hint + next-step actions, rendered as a
     *  `'guidance'` chat message after the tool_result lands. Build 140.
     *  Build 141 — `nextSteps` entries can be plain strings OR link
     *  objects that resolve to a Splunk-search-app URL at dispatch
     *  time using the dispatch's earliestTime/latestTime. */
    interpretation?: string;
    nextSteps?: Array<NextStepEntry>;
    /** Optional Splunk dispatch tokens — when provided, override any
     *  `earliest=`/`latest=` baked into the saved search's SPL. */
    earliestTime?: string;
    latestTime?: string;
}

/** Build 141 — see chat/PromptBrowser.tsx for the full type. */
export type NextStepEntry = string | { text: string; savedSearch?: string; spl?: string };

const newMessageId = (): string =>
    `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Build a catalog of canonical saved-search names + one-line descriptions
 * from the intent map. The AI receives this in its system primer so it
 * can call `splunk_run_saved_search` with REAL names, not invented ones.
 *
 * Without this, Claude tends to pattern-guess names like
 * `logserv_top_errors_last_24h` (not in our catalog) and every call
 * comes back as a 400 from the MCP server. Embedding the catalog at
 * primer-time costs ~3 KB of tokens per turn but avoids that failure
 * mode entirely. (We could alternatively make Claude call
 * `splunk_list_saved_searches` first, but that costs an extra round
 * trip per session for the same information.)
 */
interface IntentMapPromptShape {
    pack: string;
    label: string;
    description: string;
    savedSearch: string;
    /** The SPL — used by the saved search definition AND, since build 141,
     *  by the deep-dive link resolver in `resolveNextSteps()` so a
     *  `{text, savedSearch}` link can be turned into a Splunk-search URL
     *  without duplicating SPL strings. */
    spl: string;
    renderHint: 'table' | 'timechart' | 'kpi' | 'pie';
    /** Optional companion chart hint for table-primary entries. When
     *  set, ToolResultPanel renders this chart on top of the table for
     *  a same-search dual view (no extra dispatch). Omitted for
     *  raw-event tables where a chart would be misleading. */
    chartHint?: 'timechart' | 'kpi' | 'pie';
    /** Optional explicit palette for the chart. When set, ToolResultPanel
     *  uses this instead of auto-detecting from the value-field shape.
     *  Build 139 / session 025 — added to align right-pane charts with
     *  the dashboard `palette=` convention. */
    chartPalette?: ChartPalette;
    /** Optional related-dashboard mapping (build 156 / session 027).
     *  Single string or array of strings — slugs from
     *  `routes/dashboardRegistry.ts`. ChatMessage auto-appends an
     *  "Open dashboard ↗" sibling link after each `[→ saved_search]`
     *  citation, and the right-pane tile renders the same link in its
     *  title-row actions slot. */
    dashboard?: string | string[];
    /** Optional interpretation hint — 1-2 sentences of "what this means".
     *  Rendered as the body of the post-tool-result `'guidance'` chat
     *  message. Build 140 / session 025. */
    interpretation?: string;
    /** Optional ordered list of next-step / further-investigation
     *  suggestions. Each entry is either a plain string OR a link
     *  object `{text, savedSearch?, spl?}`. Build 141 — links open
     *  Splunk's search app in a new tab with a deep-dive query. */
    nextSteps?: Array<string | { text: string; savedSearch?: string; spl?: string }>;
}
interface IntentMapShape {
    prompts: IntentMapPromptShape[];
}

/**
 * saved_search_name → renderHint lookup table built from the intent map.
 *
 * Used as a fallback in the dispatch loop when Claude calls
 * `splunk_run_saved_search` without an explicit `render_hint` arg
 * (which empirically happens on EVERY call — Claude's compliance with
 * the optional schema arg is poor even when the system primer asks for
 * it). The catalog already declares the right hint per saved search;
 * this enforces it at the code layer instead of relying on AI discipline.
 *
 * Discovered in session 019 Task 1 diagnosis: across 12 dispatched tools
 * for "find my top 10 issues", Claude passed `render_hint` zero times.
 * All 12 panels rendered as tables despite catalog entries asking for
 * timechart/pie/kpi for several. The catalog-fallback restores the
 * intended chart variety without depending on the AI to pass the arg.
 */
const SAVED_SEARCH_RENDER_HINTS: Record<string, 'table' | 'timechart' | 'kpi' | 'pie'> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, 'table' | 'timechart' | 'kpi' | 'pie'> = {};
    for (const p of map.prompts) {
        out[p.savedSearch] = p.renderHint;
    }
    return out;
})();

/**
 * Companion chart hints for table-primary saved searches. When the
 * primary renderHint is `table` AND a chartHint is declared, the
 * ToolResultPanel renders the chart on top with the same data as the
 * table below — without dispatching a second saved search.
 *
 * Added in session 019 build 74: every table entry except raw-event
 * lifecycle tables gets a `pie` chartHint, so users see both the
 * sortable detail (table) and the at-a-glance shape (chart) for every
 * categorical aggregate Claude picks. Raw-event tables (sapstartsrv
 * lifecycle, hana trace fatal events) intentionally have no chartHint
 * — there's no useful chart shape for raw event rows.
 */
const SAVED_SEARCH_CHART_HINTS: Record<string, 'timechart' | 'kpi' | 'pie'> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, 'timechart' | 'kpi' | 'pie'> = {};
    for (const p of map.prompts) {
        if (p.chartHint) out[p.savedSearch] = p.chartHint;
    }
    return out;
})();

/**
 * Saved-search → chartPalette lookup. Mirrors SAVED_SEARCH_CHART_HINTS:
 * built once at module init from the intent map. Used for both the
 * canned-prompt path AND the AI-driven splunk_run_saved_search path so
 * the right-pane chart picks the dashboard-matching palette regardless
 * of how the search was dispatched.
 *
 * Build 139 / session 025: introduced to fix the "all timecharts use
 * the cool-spectrum volume palette" issue. Categorical breakdowns by
 * host / sourcetype / peer now resolve to `categorical` (high-hue-spread
 * 14-color ramp); auth events to `auth`; error rates to `errors`;
 * severity buckets to `status`. Prompts without an explicit palette
 * fall back to ToolResultPanel's auto-detect heuristic.
 */
const SAVED_SEARCH_CHART_PALETTES: Record<string, ChartPalette> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, ChartPalette> = {};
    for (const p of map.prompts) {
        if (p.chartPalette) out[p.savedSearch] = p.chartPalette;
    }
    return out;
})();

/**
 * Saved-search → related-dashboard slug(s) lookup. Build 156 / session 027.
 *
 * Each value is either a single slug or an array of slugs from
 * `routes/dashboardRegistry.ts`. Used by the chat citation parser
 * (auto-appends an "Open dashboard ↗" sibling link after `[→ saved_search]`
 * citations) AND by the right-pane ToolResultPanel (renders the same link
 * in its title-row actions slot).
 *
 * The intent map's consistency test guarantees every slug here exists in
 * the dashboard registry; runtime resolution via `resolveDashboardLinks()`
 * silently filters out anything that doesn't resolve.
 *
 * Exported so the chat citation parser can resolve `[→ saved_search]`
 * patterns to dashboard URLs even when no tool_result for that search has
 * landed yet (e.g. the AI cites a search by name in its narrative without
 * actually dispatching it).
 */
export const SAVED_SEARCH_DASHBOARDS: Record<string, string | string[]> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, string | string[]> = {};
    for (const p of map.prompts) {
        if (p.dashboard !== undefined) out[p.savedSearch] = p.dashboard;
    }
    return out;
})();

/**
 * Saved-search → interpretation lookup. Used by the canned-prompt path
 * to surface a static "How to read this result" message after the
 * tool_result lands. Build 140 / session 025.
 */
const SAVED_SEARCH_INTERPRETATIONS: Record<string, string> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, string> = {};
    for (const p of map.prompts) {
        if (p.interpretation) out[p.savedSearch] = p.interpretation;
    }
    return out;
})();

/** Saved-search → next-step suggestions lookup. Build 140 / session 025.
 *  Entries can be plain strings OR link objects `{text, savedSearch?, spl?}`
 *  (build 141). The link objects are resolved to URLs at dispatch time
 *  via `resolveNextSteps` below. */
const SAVED_SEARCH_NEXT_STEPS: Record<string, Array<NextStepEntry>> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, Array<NextStepEntry>> = {};
    for (const p of map.prompts) {
        if (p.nextSteps && p.nextSteps.length > 0) out[p.savedSearch] = p.nextSteps as Array<NextStepEntry>;
    }
    return out;
})();

/**
 * Saved-search → SPL lookup. Used to resolve `{text, savedSearch}` link
 * entries in nextSteps to their actual SPL string at runtime, avoiding
 * the need to duplicate SPL strings in two places (the prompt's `spl`
 * field AND the link). Build 141.
 */
const SAVED_SEARCH_SPL: Record<string, string> = (() => {
    const map = intentMap as unknown as IntentMapShape;
    const out: Record<string, string> = {};
    for (const p of map.prompts) {
        out[p.savedSearch] = p.spl;
    }
    return out;
})();

/**
 * Build a Splunk Search-app URL with the given SPL pre-populated and
 * the dispatch's earliestTime/latestTime applied. Opens in a new tab
 * via `target="_blank"` at the chat-render layer.
 *
 * URL pattern: /en-US/app/search/search?q=search%20<encoded_spl>&earliest=...&latest=...
 *
 * The "search" app is Splunk's universal search workspace, available
 * on every install — works regardless of whether the user is currently
 * inside the LogServ app or a different one. Build 141.
 */
const buildSplunkSearchUrl = (spl: string, earliest?: string, latest?: string): string => {
    const params = new URLSearchParams();
    params.set('q', `search ${spl}`);
    if (earliest) params.set('earliest', earliest);
    if (latest) params.set('latest', latest);
    return `/en-US/app/search/search?${params.toString()}`;
};

/**
 * Transform a raw nextSteps array (mix of strings + `{text, savedSearch?,
 * spl?}` link entries) into the resolved shape stored on the guidance
 * message — strings stay strings; link entries become `{text, url}`
 * with the URL pre-built using the dispatch's time range.
 *
 * Falls back to a plain string when a savedSearch reference can't be
 * resolved (shouldn't happen — the consistency test catches dangling
 * references at build time — but defensive in case the JSON is hand-
 * edited later). Build 141.
 */
const resolveNextSteps = (
    raw: Array<NextStepEntry>,
    earliest?: string,
    latest?: string,
): Array<string | { text: string; url: string }> => {
    return raw.map((step) => {
        if (typeof step === 'string') return step;
        let spl: string | undefined;
        if (step.savedSearch) spl = SAVED_SEARCH_SPL[step.savedSearch];
        else if (step.spl) spl = step.spl;
        if (!spl) return step.text;  // graceful fallback — render as plain string
        return { text: step.text, url: buildSplunkSearchUrl(spl, earliest, latest) };
    });
};

/**
 * Compact LogServ data-model reference for ad-hoc SPL via splunk_run_query.
 * Lists the canonical sourcetypes + the most useful field names per source.
 *
 * Kept terse to limit primer token cost while still being enough for
 * Claude to write reasonable SPL without guessing.
 */

export const useAIAssistant = (opts: UseAIAssistantOptions = {}): UseAIAssistantResult => {
    const ctx = useAIAssistantContext();
    const abortRef = useRef<AbortController | null>(null);
    const mcpAvailable = opts.mcpAvailable !== false;

    const runCannedPrompt = useCallback(
        async ({ promptId, label, spl, savedSearchName, renderHint, chartHint, chartPalette, interpretation, nextSteps, earliestTime, latestTime }: CannedPromptParams): Promise<void> => {
            const ts = Date.now();
            ctx.actions.appendMessage({
                id: newMessageId(),
                kind: 'user',
                text: label,
                ts,
            });

            const dispatchArgs: Record<string, string> = {};
            if (earliestTime) dispatchArgs.earliest_time = earliestTime;
            if (latestTime) dispatchArgs.latest_time = latestTime;

            const toolUseId = `canned-${promptId}-${ts}`;
            ctx.actions.appendMessage({
                id: newMessageId(),
                kind: 'tool_call',
                toolCall: { toolUseId, toolName: savedSearchName, args: dispatchArgs, spl },
                ts,
            });
            ctx.actions.setStatus('tool_executing');

            const t0 = performance.now();
            let result;
            try {
                result = await ctx.mcpClient.runSavedSearch(savedSearchName, dispatchArgs);
            } catch (err) {
                ctx.actions.setError(err instanceof Error ? err : new Error(String(err)));
                ctx.actions.setStatus('error');
                return;
            }
            const elapsed = Math.round(performance.now() - t0);

            ctx.actions.appendMessage({
                id: newMessageId(),
                kind: 'tool_result',
                toolResult: {
                    toolUseId,
                    result,
                    renderHint,
                    chartHint: chartHint ?? SAVED_SEARCH_CHART_HINTS[savedSearchName],
                    chartPalette: chartPalette ?? SAVED_SEARCH_CHART_PALETTES[savedSearchName],
                    displayName: savedSearchName,
                    dashboard: SAVED_SEARCH_DASHBOARDS[savedSearchName],
                    spl,
                    earliest: earliestTime,
                    latest: latestTime,
                },
                ts: Date.now(),
            });

            // Build 140: append a static guidance message right after the
            // tool_result. Sourced from the prompt descriptor's
            // `interpretation` + `nextSteps` fields. Skipped silently when
            // no interpretation was supplied (e.g. legacy callers). The
            // guidance is tied to `toolUseId` so removeToolResult can
            // prune the pair as a unit. NOT applied to the AI-driven
            // splunk_run_saved_search path — the AI writes its own
            // commentary there, and a static guidance card on top would
            // be redundant.
            const effectiveInterpretation = interpretation ?? SAVED_SEARCH_INTERPRETATIONS[savedSearchName];
            const effectiveRawNextSteps = nextSteps ?? SAVED_SEARCH_NEXT_STEPS[savedSearchName] ?? [];
            // Build 141 — resolve `{text, savedSearch}` and `{text, spl}`
            // link entries into `{text, url}` using the same earliest/
            // latest tokens we passed to the canned-prompt dispatch. The
            // resulting array is what the chat-side renderer consumes;
            // the link objects open the resolved URL in a new tab.
            const effectiveNextSteps = resolveNextSteps(effectiveRawNextSteps, earliestTime, latestTime);
            if (effectiveInterpretation && effectiveInterpretation.length > 0) {
                ctx.actions.appendMessage({
                    id: newMessageId(),
                    kind: 'guidance',
                    guidance: {
                        toolUseId,
                        interpretation: effectiveInterpretation,
                        nextSteps: effectiveNextSteps,
                    },
                    ts: Date.now(),
                });
            }
            ctx.actions.setStatus('idle');

            const inner = unwrapHidden(result);
            const auditEvent: LocalOnlyEvent = {
                category: 'local_only',
                timestamp: new Date().toISOString(),
                user: ctx.user,
                sessionId: ctx.state.sessionId,
                seq: ctx.nextAuditSeq(),
                promptId,
                spl,
                rowCount: countRows(inner.content),
                executionMs: inner.executionMs ?? elapsed,
                ok: !inner.isError,
            };
            ctx.actions.recordAudit(auditEvent);
        },
        [ctx],
    );

    const sendUserMessage = useCallback(
        async (text: string): Promise<void> => {
            // v0.0.5.0 stripped variant — the LLM-driven free-form path is
            // physically removed from the source. The chat input is also
            // disabled at the UI layer (ChatInput); this guard catches any
            // entry point (keyboard shortcut, programmatic dispatch, etc.)
            // that might still call sendUserMessage. The user sees the
            // prompt + a system notice in chat, no vendor call, no audit
            // event for vendor traffic.
            const trimmed = text.trim();
            if (!trimmed) return;
            ctx.actions.appendMessage({
                id: newMessageId(),
                kind: 'user',
                text: trimmed,
                ts: Date.now(),
            });
            ctx.actions.appendMessage({
                id: newMessageId(),
                kind: 'system_notice',
                text:
                    'Free-form prompts are not available in this build — the ' +
                    'LLM-driven dispatch path has been removed from the source. ' +
                    'Click "Browse predefined prompts" below to run a saved search.',
                ts: Date.now(),
            });
        },
        [ctx],
    );

    const abort = useCallback((): void => {
        abortRef.current?.abort();
        ctx.actions.setStatus('idle');
    }, [ctx]);

    return { runCannedPrompt, sendUserMessage, abort };
};

const countRows = (content: unknown): number => {
    if (!content) return 0;
    if (Array.isArray(content)) return content.length;
    if (typeof content === 'object') {
        const c = content as Record<string, unknown>;
        if (Array.isArray(c.rows)) return c.rows.length;
        if (typeof c.totalRowCount === 'number') return c.totalRowCount;
    }
    return 0;
};
export type { DisplayMessage };
