import { Hidden, markHidden } from '../types/Hidden';
import { readCredentialClear } from '../../../utils/passwordsApi';
import { clearAIConfigCache, readAIConfig } from '../../../utils/aiConfigApi';

const MCP_BEARER_REALM = 'logserv_ai_assistant_mcp';

/**
 * MCP client — talks to the official Splunk MCP Server (Splunkbase App
 * 7931, v1.1.0+) at `/services/mcp` (typically proxied through Splunk
 * Web's `/splunkd/__raw/` path, but can also be a self-hosted endpoint
 * on a different host:port via the admin Settings page).
 *
 * Auth model — both layers are sent simultaneously so the server can
 * accept either:
 *   1. **Bearer token** in the `Authorization` header. Read from the
 *      `logserv_ai_assistant_mcp` realm, name `bearer_token`. The admin
 *      pastes a pre-obtained OAuth/JWT token in the Settings page;
 *      Phase G replaces this with auto-mint via a Data TA-side Python
 *      REST handler.
 *   2. **Splunk Web cookie** via `credentials: 'same-origin'`. Used only
 *      when no bearer token is configured (default at first install).
 *
 * On a 401 response, the credential cache is invalidated and the request
 * retries once. If the second attempt also returns 401, the caller gets
 * a `MCPClientError` with a "Configure MCP credentials in Settings"
 * message.
 *
 * **Privacy invariant:** every result returned from `invokeTool()` and
 * `runSavedSearch()` is typed `Hidden<T>`, so the type system blocks
 * those values from being placed into the AI Provider's outbound
 * payload. The only path Hidden → Visible is `sanitize()` (defined in
 * Phase A's Visible.ts).
 *
 * See `ai_assistant_design_v0.1_20260427.md` §4 for the full MCP design.
 */

export interface MCPServerInfo {
    /** Server version, e.g., "1.1.0". */
    version: string;
    /** Server's announced protocol version. */
    protocolVersion: string;
    /** Server-declared capabilities, opaque to us. */
    capabilities: Readonly<Record<string, unknown>>;
    /** Server name (e.g., "splunk-mcp-server"). */
    name: string;
}

export interface MCPToolInfo {
    name: string;
    description: string;
    inputSchema: Readonly<Record<string, unknown>>;
}

export interface MCPSavedSearchInfo {
    name: string;
    description: string;
    /** Whether the search has parameters that callers must supply. */
    isParameterized: boolean;
}

export interface MCPToolResult {
    /** Tool's structured payload. Shape depends on the tool. For App
     *  7931 saved-search calls this is an array of `{type, text}` parts
     *  where `text` is a JSON-stringified results envelope. Prefer
     *  `structuredContent` when present — it's the same data as objects
     *  rather than a re-serialized string. */
    content: unknown;
    /** MCP 2025-06-18 protocol addition: the same payload as `content`
     *  but already parsed into objects. App 7931 returns this for
     *  `splunk_run_saved_search` (`{ results, truncated, total_rows }`)
     *  and `splunk_run_query`. Other tools may omit it. */
    structuredContent?: unknown;
    /** Whether the tool reported an error. */
    isError: boolean;
    /** Optional error message if `isError` is true. */
    errorMessage?: string;
    /** Tool execution time in milliseconds (if reported). */
    executionMs?: number;
}

export interface MCPHttpClientOptions {
    /** Base URL for the MCP server, defaults to the App 7931 location.
     *  Override only for tests or self-hosted sidecar mode. */
    endpointUrl?: string;
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
    /** Request timeout in ms. Defaults to 30s. */
    timeoutMs?: number;
}

/**
 * Default MCP endpoint — the official Splunk MCP Server (App 7931)
 * mounts at `/services/mcp` on splunkd; Splunk Web exposes splunkd via
 * `/splunkd/__raw/`. This is a scheme-relative path: requests inherit
 * the page's protocol (HTTP or HTTPS), so the default works regardless
 * of how Splunk Web is configured.
 *
 * Resolution order at each `jsonrpcCall`:
 *   1. Constructor-provided `endpointUrl` (used by tests / sidecar
 *      override).
 *   2. `mcp_server_url` from `ai_assistant_settings.conf [defaults]` —
 *      admin configures this in the Settings page (General panel).
 *      Wins over the default when set, e.g., a hosted MCP server on a
 *      different host:port. Whatever scheme the admin puts in (http or
 *      https) is what the request uses.
 *   3. This default — the local splunkd's mounted MCP route, served
 *      via the same Splunk Web instance the user is signed in to.
 */
const DEFAULT_MCP_ENDPOINT = '/en-US/splunkd/__raw/services/mcp';

const MCP_FIELD_BEARER_TOKEN = 'bearer_token';

/**
 * MCPClient — Phase B implementation.
 *
 * Implements just enough of the MCP protocol to:
 *  - check server health/version (`info()`)
 *  - enumerate tools and saved searches
 *  - invoke a tool (returns Hidden<MCPToolResult>)
 *
 * Real streaming support (SSE chunks during long tool runs) is a Phase C
 * concern — the chat UI consumes streaming. Phase B's invocation is
 * single-shot request/response, sufficient for health checks and the
 * canned-prompt one-click execution path.
 */
export class MCPClient {
    /** Optional constructor override — when set, bypasses the
     *  Settings-stored `server_url` and pins the URL for this instance.
     *  Used by tests and the future self-hosted-sidecar mode. */
    private readonly endpointUrlOverride: string | null;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;
    private requestIdCounter = 0;

    constructor(opts: MCPHttpClientOptions = {}) {
        this.endpointUrlOverride = opts.endpointUrl ?? null;
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
        this.timeoutMs = opts.timeoutMs ?? 30000;
    }

    /** Resolve the effective endpoint URL: constructor override → admin
     *  Settings (`ai_assistant_settings.conf`) → default. Errors reading
     *  the conf are non-fatal and fall through to the default. */
    private async resolveEndpointUrl(): Promise<string> {
        if (this.endpointUrlOverride) return this.endpointUrlOverride;
        try {
            const cfg = await readAIConfig();
            if (cfg.mcp_server_url && cfg.mcp_server_url.length > 0) {
                return cfg.mcp_server_url;
            }
        } catch {
            // Read failure → fall through to default. Avoids surfacing
            // a transient REST hiccup as a fatal MCP error.
        }
        return DEFAULT_MCP_ENDPOINT;
    }

    /** Read the bearer token from `passwords.conf`. Returns null when
     *  unset (admin hasn't pasted one), in which case requests fall back
     *  to cookie-only auth. */
    private async resolveBearerToken(): Promise<string | null> {
        try {
            const v = await readCredentialClear(MCP_BEARER_REALM, MCP_FIELD_BEARER_TOKEN);
            return v.length > 0 ? v : null;
        } catch {
            return null;
        }
    }

    /**
     * Get server info — version, protocol, capabilities. Used by the
     * health check (`useMCPHealth`) at app load.
     */
    async info(): Promise<MCPServerInfo> {
        const result = await this.jsonrpcCall('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'logserv-ai-assistant', version: '0.0.5' },
        });
        if (result.error) {
            throw new MCPClientError(
                `MCP server returned error during initialize: ${result.error.message}`,
                result.error.code,
            );
        }
        const r = (result.result ?? {}) as Record<string, unknown>;
        const serverInfo = (r.serverInfo ?? {}) as Record<string, unknown>;
        return {
            version: typeof serverInfo.version === 'string' ? serverInfo.version : '0.0.0',
            protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion : '0.0.0',
            capabilities: (r.capabilities as Record<string, unknown>) ?? {},
            name: typeof serverInfo.name === 'string' ? serverInfo.name : 'unknown',
        };
    }

    /**
     * List the tools the MCP server exposes. The result is Visible (just
     * tool descriptors, not data), so the AI vendor adapter is free to
     * include them in its tool-definitions payload.
     */
    async listTools(): Promise<MCPToolInfo[]> {
        const result = await this.jsonrpcCall('tools/list', {});
        if (result.error) {
            throw new MCPClientError(
                `MCP tools/list error: ${result.error.message}`,
                result.error.code,
            );
        }
        const r = (result.result ?? {}) as Record<string, unknown>;
        const tools = (r.tools as Array<Record<string, unknown>>) ?? [];
        return tools.map((t) => ({
            name: typeof t.name === 'string' ? t.name : '',
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        }));
    }

    /**
     * List saved searches the MCP server has discovered in the user's
     * Splunk apps. App 7931's `splunk_*` namespace exposes this; we use
     * it to discover our own LogServ saved searches plus anything the
     * customer has added.
     */
    async listSavedSearches(): Promise<MCPSavedSearchInfo[]> {
        const result = await this.callTool('splunk_list_saved_searches', {});
        const inner = (result.content as Record<string, unknown> | null) ?? {};
        const items = (inner.savedSearches as Array<Record<string, unknown>>) ?? [];
        return items.map((s) => ({
            name: typeof s.name === 'string' ? s.name : '',
            description: typeof s.description === 'string' ? s.description : '',
            isParameterized:
                typeof s.isParameterized === 'boolean' ? s.isParameterized : false,
        }));
    }

    /**
     * Invoke an MCP tool by name. Result is Hidden — the type system
     * blocks it from entering an AI vendor outbound payload.
     */
    async invokeTool(name: string, args: object): Promise<Hidden<MCPToolResult>> {
        const result = await this.callTool(name, args);
        return markHidden(result);
    }

    /**
     * Run a Splunk saved search by name. Convenience wrapper around
     * `invokeTool('splunk_run_saved_search', { saved_search_name, ... })`.
     * Result is Hidden.
     *
     * Argument naming follows the official Splunk MCP Server (App 7931)
     * `splunk_run_saved_search` tool schema: the saved search identifier
     * is `saved_search_name` (NOT `name` — that's reserved for the
     * outer tool name in the JSON-RPC envelope). The optional caller
     * args go in `arguments`.
     */
    async runSavedSearch(name: string, args: object = {}): Promise<Hidden<MCPToolResult>> {
        const result = await this.callTool('splunk_run_saved_search', {
            saved_search_name: name,
            arguments: args,
        });
        return markHidden(result);
    }

    /**
     * Internal helper: invoke a tool and return the unwrapped MCPToolResult.
     * Marked Hidden by the public callers above; this private path is
     * intentionally not Hidden to allow internal post-processing (e.g.,
     * unwrapping savedSearches list which is metadata, not data).
     */
    private async callTool(name: string, args: object): Promise<MCPToolResult> {
        const result = await this.jsonrpcCall('tools/call', {
            name,
            arguments: args,
        });
        if (result.error) {
            return {
                content: null,
                isError: true,
                errorMessage: result.error.message,
            };
        }
        const r = (result.result ?? {}) as Record<string, unknown>;
        return {
            content: r.content ?? null,
            structuredContent: r.structuredContent,
            isError: typeof r.isError === 'boolean' ? r.isError : false,
            errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : undefined,
            executionMs:
                typeof r.executionMs === 'number' ? r.executionMs : undefined,
        };
    }

    /**
     * Issue a single JSON-RPC request to the MCP server. Returns the
     * parsed JSON-RPC envelope (with `result` or `error`).
     *
     * On HTTP 401, the credential cache is invalidated and the request
     * is retried once with freshly-read credentials. A second 401 throws
     * a `MCPClientError` with code `http_401` and a message directing
     * the admin to the Settings page.
     */
    private async jsonrpcCall(
        method: string,
        params: object,
    ): Promise<JsonRpcResponse> {
        this.requestIdCounter += 1;
        const requestId = this.requestIdCounter;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            method,
            params,
        });

        const sendOnce = async (): Promise<Response> => {
            const url = await this.resolveEndpointUrl();
            const token = await this.resolveBearerToken();
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'X-Requested-With': 'XMLHttpRequest',
            };
            if (token) headers.Authorization = `Bearer ${token}`;

            const controller = new AbortController();
            const timeoutHandle = setTimeout(
                () => controller.abort(),
                this.timeoutMs,
            );
            try {
                return await this.fetchImpl(url, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers,
                    body,
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutHandle);
            }
        };

        let response = await sendOnce();
        if (response.status === 401) {
            // Cached config may be stale (admin updated via Settings,
            // or the bearer token expired). Force-refresh and retry once.
            clearAIConfigCache();
            response = await sendOnce();
            if (response.status === 401) {
                throw new MCPClientError(
                    'MCP server rejected the request (HTTP 401). ' +
                        'Configure or refresh MCP credentials in the AI ' +
                        'Assistant Settings page.',
                    'http_401',
                );
            }
        }

        if (!response.ok) {
            throw new MCPClientError(
                `MCP server returned HTTP ${response.status}`,
                `http_${response.status}`,
            );
        }

        const json = (await response.json()) as JsonRpcResponse;
        if (json.id !== requestId && json.id !== null) {
            // App 7931 should echo our request id; mismatch is suspicious.
            // eslint-disable-next-line no-console
            console.warn(
                `[MCPClient] Response id mismatch — sent ${requestId}, got ${json.id}`,
            );
        }
        return json;
    }
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: Record<string, unknown>;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export class MCPClientError extends Error {
    public readonly code: string | number;
    constructor(message: string, code: string | number) {
        super(message);
        this.name = 'MCPClientError';
        this.code = code;
    }
}
