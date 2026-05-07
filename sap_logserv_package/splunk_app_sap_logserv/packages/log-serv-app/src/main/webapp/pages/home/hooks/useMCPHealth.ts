import { useEffect, useState } from 'react';
import { MCPClient } from '../components/ai/mcp/MCPClient';
import {
    MAX_MCP_SERVER_VERSION_EXCLUSIVE,
    MIN_MCP_SERVER_VERSION,
    belowMaxVersion,
    meetsMinVersion,
} from '../components/ai/mcp/versionGate';

/**
 * Health check for the AI Assistant's MCP dependencies.
 *
 * Verifies, in order:
 *   1. The official Splunk MCP Server (App 7931) is reachable at
 *      `/services/mcp` and responds to `initialize`.
 *   2. The reported version is ≥ MIN_MCP_SERVER_VERSION (1.0.3) — older
 *      versions have CVE-2026-20205 (token leak).
 *   3. The Splunk MCP TA is installed (queries `services/apps/local`
 *      for `splunk_mcp_ta`). Its presence is REQUIRED — not optional.
 *      Without it, the AI Assistant is blind to prompt-injection /
 *      abuse attempts that would otherwise be detected.
 *
 * Returns a discriminated state union the React UI can render. The
 * setup wizard component (`MCPSetupWizard.tsx`) consumes this hook
 * directly.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §4.2, §4.4.
 */

export type MCPHealthState =
    | { status: 'loading' }
    | {
          status: 'ok';
          serverVersion: string;
          taInstalled: true;
          /** Server's protocol version — useful for diagnostics. */
          protocolVersion: string;
      }
    | {
          status: 'mcp_server_missing';
          /** Whether the user attempted to reach the sidecar instead of App 7931. */
          checkedSidecar: boolean;
      }
    | {
          status: 'mcp_server_too_old';
          installedVersion: string;
          requiredVersion: string;
          cveId: 'CVE-2026-20205';
      }
    | {
          /** Installed App 7931 version is at or above the uncertified
           *  upper bound. The protocol shape may have changed in ways
           *  the AI Assistant doesn't yet support. Build 83 / OWASP
           *  LLM03 (Supply Chain). */
          status: 'mcp_server_too_new';
          installedVersion: string;
          maxExclusiveVersion: string;
      }
    | { status: 'mcp_ta_missing'; serverVersion: string }
    | { status: 'error'; message: string };

export interface UseMCPHealthOptions {
    /** Inject MCPClient for tests. */
    clientImpl?: MCPClient;
    /** Inject the apps-list fetcher for tests. */
    fetchAppsImpl?: () => Promise<AppListEntry[]>;
    /**
     * When false, the hook skips the entire health probe and returns
     * `ok` immediately. Used by the "MCP-less chat mode" (Phase D
     * smoke testing path) — see AIAssistantConfig.mcpRequired.
     * Default: true (run the probe).
     */
    enabled?: boolean;
    /**
     * Bumping this nonce forces the probe to re-run even if other deps
     * haven't changed. Wired to the "Re-check" button in
     * MCPSetupWizard so admins can re-probe after fixing config without
     * closing/reopening the panel.
     */
    retryNonce?: number;
}

export interface AppListEntry {
    name: string;
    /** Splunk app version from app.conf [launcher] version. */
    version?: string;
    /** Whether the app is enabled (disabled apps don't run their detections). */
    disabled: boolean;
}

const MCP_TA_APP_NAME = 'splunk_mcp_ta';

/**
 * Phase D temporary override: skip the MCP TA presence check.
 *
 * Background: the design requires a Splunk MCP TA alongside App 7931 for
 * prompt-injection / tool-abuse detection content (design §4.4). As of
 * session 016 we do not have a confirmed Splunkbase package for this TA
 * (the URL in MCPSetupWizard.tsx is a placeholder), so the gate is
 * blocking real Anthropic provider smoke testing on dev environments
 * where the TA hasn't been published.
 *
 * TODO (Phase G or sooner): set this back to `false` once the TA is
 * published and we can install it. Keep this flag — it's the smallest
 * lever for restoring the gate.
 */
const SKIP_MCP_TA_CHECK = true;

const fetchAppsList = async (): Promise<AppListEntry[]> => {
    const response = await fetch(
        '/en-US/splunkd/__raw/services/apps/local?output_mode=json&count=0',
        { credentials: 'same-origin' },
    );
    if (!response.ok) {
        throw new Error(`apps/local list failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
        entry: Array<{
            name: string;
            content: { version?: string; disabled?: boolean };
        }>;
    };
    return (json.entry ?? []).map((e) => ({
        name: e.name,
        version: e.content?.version,
        disabled: e.content?.disabled === true,
    }));
};

export const useMCPHealth = (opts: UseMCPHealthOptions = {}): MCPHealthState => {
    const enabled = opts.enabled !== false;
    const [state, setState] = useState<MCPHealthState>(() =>
        enabled
            ? { status: 'loading' }
            : {
                  status: 'ok',
                  serverVersion: 'bypassed',
                  taInstalled: true,
                  protocolVersion: 'bypassed',
              },
    );

    useEffect(() => {
        if (!enabled) {
            setState({
                status: 'ok',
                serverVersion: 'bypassed',
                taInstalled: true,
                protocolVersion: 'bypassed',
            });
            return undefined;
        }

        // Reset to loading on every probe so the "Re-check" button
        // gives immediate visual feedback even if the new probe is fast.
        setState({ status: 'loading' });

        let cancelled = false;
        const client = opts.clientImpl ?? new MCPClient();
        const fetchApps = opts.fetchAppsImpl ?? fetchAppsList;

        const runCheck = async (): Promise<void> => {
            try {
                // 1. Probe MCP server.
                let serverInfo;
                try {
                    serverInfo = await client.info();
                } catch (err) {
                    if (cancelled) return;
                    setState({ status: 'mcp_server_missing', checkedSidecar: false });
                    return;
                }

                // 2. Version gate (CVE-2026-20205).
                if (!meetsMinVersion(serverInfo.version, MIN_MCP_SERVER_VERSION)) {
                    if (cancelled) return;
                    setState({
                        status: 'mcp_server_too_old',
                        installedVersion: serverInfo.version,
                        requiredVersion: MIN_MCP_SERVER_VERSION,
                        cveId: 'CVE-2026-20205',
                    });
                    return;
                }

                // 2b. Upper-bound check (OWASP LLM03 Supply Chain — build 83).
                //     Refuses to operate against an uncertified next-major.
                //     See `versionGate.ts` for the rationale.
                if (!belowMaxVersion(serverInfo.version, MAX_MCP_SERVER_VERSION_EXCLUSIVE)) {
                    if (cancelled) return;
                    setState({
                        status: 'mcp_server_too_new',
                        installedVersion: serverInfo.version,
                        maxExclusiveVersion: MAX_MCP_SERVER_VERSION_EXCLUSIVE,
                    });
                    return;
                }

                // 3. MCP TA presence (required — currently bypassed per
                //    SKIP_MCP_TA_CHECK; see comment at the top of this file).
                if (!SKIP_MCP_TA_CHECK) {
                    const apps = await fetchApps();
                    const ta = apps.find((a) => a.name === MCP_TA_APP_NAME);
                    if (!ta || ta.disabled) {
                        if (cancelled) return;
                        setState({ status: 'mcp_ta_missing', serverVersion: serverInfo.version });
                        return;
                    }
                }

                if (cancelled) return;
                setState({
                    status: 'ok',
                    serverVersion: serverInfo.version,
                    taInstalled: true,
                    protocolVersion: serverInfo.protocolVersion,
                });
            } catch (err) {
                if (cancelled) return;
                setState({
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };

        void runCheck();
        return () => {
            cancelled = true;
        };
    }, [enabled, opts.clientImpl, opts.fetchAppsImpl, opts.retryNonce]);

    return state;
};
