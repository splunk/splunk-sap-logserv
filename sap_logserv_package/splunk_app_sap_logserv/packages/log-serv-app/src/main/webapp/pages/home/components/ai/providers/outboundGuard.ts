import { Message, ToolDef, unwrapVisible } from '../types';

/**
 * Outbound guard — the privacy chokepoint.
 *
 * Two layers of defense:
 *
 *   1. **Compile-time** (in the type system): the function signature
 *      accepts only `Message[]` and `ToolDef[]`. Both contain only
 *      `Visible<T>` content. There is no path to put a `Hidden<T>`
 *      value into either type without first running it through
 *      `sanitize()` (which forces the caller to provide a non-data
 *      summary string).
 *
 *   2. **Runtime defense-in-depth** (in this file): the constructed
 *      payload is JSON-serialized and scanned for forbidden field
 *      names that should never appear in an outbound payload (e.g.,
 *      `_raw`, `_time`, `host`, `source`, `sourcetype`, `index`,
 *      `_indextime`, `_serial`, `_subsecond`). If any forbidden
 *      field name appears as a JSON key, the function throws — the
 *      payload never leaves.
 *
 * Layer 1 catches programmer error (someone tries to put Splunk data
 * directly into a Message). Layer 2 catches a hypothetical type-system
 * escape (e.g., `as any`, a code-gen bug, a malicious dependency
 * injecting via prototype pollution). Either is sufficient on its own;
 * both together is the standard.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §2.2.
 */

/**
 * Field names that should never appear as JSON keys in any outbound
 * payload. These are Splunk's internal field names plus a curated set of
 * commonly-extracted identifiers from the LogServ data inventory.
 *
 * If the AI vendor's protocol legitimately needs a key called e.g.
 * `source` (it doesn't, as of the providers we support), this list
 * needs surgical exceptions. For now: hard reject.
 */
export const FORBIDDEN_FIELD_NAMES: ReadonlySet<string> = new Set([
    // Splunk internal fields
    '_raw',
    '_time',
    '_indextime',
    '_serial',
    '_subsecond',
    '_cd',
    '_si',
    '_kv',
    'host',
    'source',
    'sourcetype',
    'index',
    'splunk_server',
    'punct',
    'linecount',
    'eventtype',
    'tag',
    'tags',
    // LogServ-specific identifiers we never want flowing externally
    'sap_sid',
    'sap_cid',
    'sap_inst',
    'clz_dir',
    'clz_subdir',
]);

export interface VendorPayload {
    /** Provider-agnostic representation; vendor adapters serialize as needed. */
    messages: VendorMessage[];
    tools: VendorToolDef[];
}

export interface VendorMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** Vendor-style tool calls, if this is an assistant message. */
    toolCalls?: VendorToolCall[];
    /** Tool results being fed back to the AI (user-role messages only).
     *  The summary string is the ONLY view the AI gets of past results;
     *  it never sees row data. */
    toolResults?: VendorToolResult[];
}

export interface VendorToolCall {
    id: string;
    name: string;
    args: string;
}

export interface VendorToolResult {
    toolUseId: string;
    /** Sanitized non-data summary, derived via `sanitize()`. */
    summary: string;
    isError?: boolean;
}

export interface VendorToolDef {
    name: string;
    description: string;
    inputSchema: object;
}

/**
 * Build the outbound payload from compile-time-safe inputs, then run
 * the runtime defense-in-depth scan.
 *
 * Throws `OutboundGuardError` if the runtime scan detects a forbidden
 * key. Never returns a payload that contains forbidden data.
 */
export const buildOutboundPayload = (
    messages: ReadonlyArray<Message>,
    tools: ReadonlyArray<ToolDef>,
): VendorPayload => {
    const payload: VendorPayload = {
        messages: messages.map((m) => ({
            role: m.role,
            content: unwrapVisible(m.content),
            toolCalls: m.toolCalls?.map((tc) => ({
                id: unwrapVisible(tc.toolUseId),
                name: unwrapVisible(tc.toolName),
                args: unwrapVisible(tc.args),
            })),
            toolResults: m.toolResults?.map((tr) => ({
                toolUseId: unwrapVisible(tr.toolUseId),
                summary: unwrapVisible(tr.summary),
                isError: tr.isError,
            })),
        })),
        tools: tools.map((t) => ({
            name: unwrapVisible(t.name),
            description: unwrapVisible(t.description),
            inputSchema: unwrapVisible(t.inputSchema),
        })),
    };

    const violations = scanForForbiddenKeys(payload);
    if (violations.length > 0) {
        throw new OutboundGuardError(
            `Outbound payload contains forbidden keys: ${violations.join(', ')}. ` +
            `This is a defense-in-depth check; the type system should have prevented this. ` +
            `Investigate the call site immediately.`,
            violations,
        );
    }

    return payload;
};

/**
 * Recursively walk a JSON-serializable value and return any forbidden
 * key names found at any depth. Returns unique keys, not paths — the
 * intent is to halt sending and surface "what shouldn't be here", not
 * to point to where in the structure.
 */
export const scanForForbiddenKeys = (value: unknown): string[] => {
    const found = new Set<string>();
    walk(value, found);
    return Array.from(found).sort();
};

const walk = (value: unknown, found: Set<string>): void => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) walk(item, found);
        return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
        if (FORBIDDEN_FIELD_NAMES.has(key)) {
            found.add(key);
        }
        walk((value as Record<string, unknown>)[key], found);
    }
};

export class OutboundGuardError extends Error {
    public readonly violations: ReadonlyArray<string>;
    constructor(message: string, violations: ReadonlyArray<string>) {
        super(message);
        this.name = 'OutboundGuardError';
        this.violations = violations;
    }
}
