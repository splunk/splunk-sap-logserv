/**
 * mcpErrorDetect — detect "soft" error responses from the Splunk MCP
 * Server that the JSON-RPC envelope reports as success.
 *
 * Background: when a tool call fails for a domain reason (e.g., the
 * saved-search name doesn't exist), the MCP Server returns a
 * structurally-successful response where `content[0].text` is a
 * stringified error envelope `{status_code: 400, content: "..."}`.
 * The JSON-RPC layer is happy; only the inner payload signals failure.
 *
 * Without detection, the React result panel renders that envelope as
 * a single-row table with the raw JSON in the cell, AND the AI's
 * summary aggregator runs over the 1-row error envelope and reports
 * meaningless "stats" instead of telling Claude "this call failed".
 */

import { MCPToolResult } from '../components/ai/mcp/MCPClient';

export interface DetectedToolError {
    statusCode?: number;
    message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

/**
 * Inspect `content[0].text` (and `structuredContent`) for the
 * `{status_code, content}` shape App 7931 uses for soft errors.
 * Returns the parsed error or `null` if the response looks healthy.
 */
export const detectToolError = (inner: MCPToolResult): DetectedToolError | null => {
    // Hard error already flagged by the JSON-RPC layer — caller handles
    // it via `inner.errorMessage`.
    if (inner.isError) {
        return { message: inner.errorMessage ?? 'Tool error' };
    }

    // Look at structuredContent first (cheaper, no parse step).
    if (isObject(inner.structuredContent)) {
        const sc = inner.structuredContent;
        const code = typeof sc.status_code === 'number' ? sc.status_code : undefined;
        const msg = typeof sc.content === 'string' ? sc.content : undefined;
        if (code !== undefined && code >= 400 && msg) {
            return { statusCode: code, message: msg };
        }
    }

    // Fall back to parsing content[0].text.
    if (Array.isArray(inner.content) && inner.content.length > 0) {
        const first = inner.content[0];
        if (isObject(first) && typeof first.text === 'string') {
            try {
                const parsed: unknown = JSON.parse(first.text);
                if (isObject(parsed)) {
                    const code = typeof parsed.status_code === 'number' ? parsed.status_code : undefined;
                    const msg = typeof parsed.content === 'string' ? parsed.content : undefined;
                    if (code !== undefined && code >= 400 && msg) {
                        return { statusCode: code, message: msg };
                    }
                }
            } catch (_e) { /* not JSON; not an error envelope */ }
        }
    }
    return null;
};
