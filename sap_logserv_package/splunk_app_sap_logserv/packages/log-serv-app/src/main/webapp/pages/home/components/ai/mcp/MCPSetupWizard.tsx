import React from 'react';
import styled from 'styled-components';
import { logservTheme } from '../../../styles/logservTheme';
import { MCPHealthState } from '../../../hooks/useMCPHealth';

/**
 * MCPSetupWizard — shown when `useMCPHealth` reports anything other
 * than `status: 'ok'`. The user cannot use the AI Assistant until the
 * underlying issue is resolved.
 *
 * Each failure mode has its own remediation copy and (where applicable)
 * a deep link to Splunkbase or to the customer's Splunk admin pages.
 *
 * See `ai_assistant_design_v0.1_20260427.md` §4.2.
 */

interface MCPSetupWizardProps {
    health: MCPHealthState;
    /** Called when the user clicks "retry" — typically re-runs `useMCPHealth`. */
    onRetry?: () => void;
}

const Card = styled.section`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    padding: ${logservTheme.spacing.xxl};
    color: ${logservTheme.colors.textActive};
    max-width: 720px;
    margin: ${logservTheme.spacing.xxl} auto;
`;

const Title = styled.h2`
    margin: 0 0 ${logservTheme.spacing.md} 0;
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.xlarge};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Subtitle = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    margin-bottom: ${logservTheme.spacing.lg};
`;

const SeverityBadge = styled.span<{ $severity: 'info' | 'warning' | 'error' }>`
    display: inline-block;
    padding: 2px 8px;
    border-radius: 2px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: ${logservTheme.spacing.md};
    background: ${(p) =>
        p.$severity === 'error'
            ? logservTheme.colors.red
            : p.$severity === 'warning'
            ? logservTheme.colors.orange
            : logservTheme.colors.cyanAccent};
    color: white;
`;

const Body = styled.div`
    color: ${logservTheme.colors.textDefault};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
    margin-bottom: ${logservTheme.spacing.lg};

    & code {
        background: ${logservTheme.colors.tableHeaderBackground};
        padding: 1px 6px;
        border-radius: 2px;
        font-family: ${logservTheme.font.mono};
        font-size: 0.92em;
    }
`;

const ActionRow = styled.div`
    display: flex;
    gap: ${logservTheme.spacing.md};
    align-items: center;
    margin-top: ${logservTheme.spacing.lg};
`;

const PrimaryButton = styled.a`
    display: inline-block;
    background: ${logservTheme.colors.cyanAccent};
    color: white;
    text-decoration: none;
    padding: 8px 16px;
    border-radius: 2px;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    cursor: pointer;

    &:hover { opacity: 0.9; }
`;

const SecondaryButton = styled.button`
    background: transparent;
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorder};
    padding: 8px 16px;
    border-radius: 2px;
    font-size: ${logservTheme.fontSize.body};
    cursor: pointer;
    font-family: inherit;

    &:hover { background: ${logservTheme.colors.hoverBackground}; }
`;

const Loader = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    text-align: center;
    padding: ${logservTheme.spacing.xxl};
`;

const SPLUNKBASE_MCP_SERVER_URL = 'https://splunkbase.splunk.com/app/7931';
const SPLUNKBASE_MCP_TA_URL = 'https://splunkbase.splunk.com/app/splunk-mcp-ta';

const MCPSetupWizard: React.FC<MCPSetupWizardProps> = ({ health, onRetry }) => {
    if (health.status === 'loading') {
        return (
            <Card>
                <Loader>Checking AI Assistant prerequisites…</Loader>
            </Card>
        );
    }

    if (health.status === 'ok') {
        // Caller should not render the wizard when health is ok;
        // defensive return so we never hide the chat by accident.
        return null;
    }

    if (health.status === 'mcp_server_missing') {
        return (
            <Card>
                <SeverityBadge $severity="error">Setup required</SeverityBadge>
                <Title>AI Assistant requires the Splunk MCP Server</Title>
                <Subtitle>
                    The Splunk MCP Server (Splunkbase App 7931) is not installed or is not
                    reachable on this Search Head.
                </Subtitle>
                <Body>
                    The AI Assistant uses Splunk’s official MCP Server for query execution and
                    tool dispatch. Splunk owns the protocol, authentication, RBAC, and security
                    response for that app — we depend on it rather than ship our own.
                    <br />
                    <br />
                    Install the app from Splunkbase, then return to this page.
                </Body>
                <ActionRow>
                    <PrimaryButton href={SPLUNKBASE_MCP_SERVER_URL} target="_blank" rel="noreferrer">
                        Install Splunkbase App 7931
                    </PrimaryButton>
                    {onRetry && <SecondaryButton onClick={onRetry}>Re-check</SecondaryButton>}
                </ActionRow>
            </Card>
        );
    }

    if (health.status === 'mcp_server_too_old') {
        return (
            <Card>
                <SeverityBadge $severity="error">Security upgrade required</SeverityBadge>
                <Title>Splunk MCP Server v{health.installedVersion} is vulnerable</Title>
                <Subtitle>
                    Versions before {health.requiredVersion} have <code>{health.cveId}</code> —
                    a token-leak in <code>_internal</code> visible to any user with{' '}
                    <code>mcp_tool_admin</code>.
                </Subtitle>
                <Body>
                    The AI Assistant refuses to operate against vulnerable versions. Upgrade
                    the Splunk MCP Server app to <code>{health.requiredVersion}</code> or later
                    on this Search Head, then return to this page.
                </Body>
                <ActionRow>
                    <PrimaryButton href={SPLUNKBASE_MCP_SERVER_URL} target="_blank" rel="noreferrer">
                        Open Splunkbase App 7931
                    </PrimaryButton>
                    {onRetry && <SecondaryButton onClick={onRetry}>Re-check</SecondaryButton>}
                </ActionRow>
            </Card>
        );
    }

    if (health.status === 'mcp_server_too_new') {
        return (
            <Card>
                <SeverityBadge $severity="warning">Uncertified version</SeverityBadge>
                <Title>Splunk MCP Server v{health.installedVersion} is not yet certified</Title>
                <Subtitle>
                    The AI Assistant has been validated against versions{' '}
                    <code>&lt; {health.maxExclusiveVersion}</code>. The installed
                    version is at or above that line and may have changed the
                    protocol shape we depend on.
                </Subtitle>
                <Body>
                    This is intentional — a Splunk MCP Server major release can
                    rename tools, change the request/response envelope, or alter
                    error handling in ways that would silently break tool dispatch.
                    Until our team re-certifies the AI Assistant against the new
                    major, we refuse to operate so admins see a clear cause
                    instead of cryptic errors.
                    <br />
                    <br />
                    Either downgrade the Splunk MCP Server to a certified version
                    (<code>&lt; {health.maxExclusiveVersion}</code>), or wait for an
                    AI Assistant update that bumps the certified upper bound.
                </Body>
                <ActionRow>
                    <PrimaryButton href={SPLUNKBASE_MCP_SERVER_URL} target="_blank" rel="noreferrer">
                        Open Splunkbase App 7931
                    </PrimaryButton>
                    {onRetry && <SecondaryButton onClick={onRetry}>Re-check</SecondaryButton>}
                </ActionRow>
            </Card>
        );
    }

    if (health.status === 'mcp_ta_missing') {
        return (
            <Card>
                <SeverityBadge $severity="warning">Required dependency missing</SeverityBadge>
                <Title>Splunk MCP TA is required</Title>
                <Subtitle>
                    The MCP Server is installed (v{health.serverVersion}) but the companion
                    Splunk MCP TA is missing or disabled.
                </Subtitle>
                <Body>
                    The MCP TA contains detection content for prompt-injection and tool-abuse
                    patterns. Operating the AI Assistant without it would leave you blind to
                    abuse attempts that the TA would otherwise surface — so we require it.
                    Install or enable the TA, then return to this page.
                </Body>
                <ActionRow>
                    <PrimaryButton href={SPLUNKBASE_MCP_TA_URL} target="_blank" rel="noreferrer">
                        Install Splunk MCP TA
                    </PrimaryButton>
                    {onRetry && <SecondaryButton onClick={onRetry}>Re-check</SecondaryButton>}
                </ActionRow>
            </Card>
        );
    }

    // status === 'error'
    return (
        <Card>
            <SeverityBadge $severity="error">Health check error</SeverityBadge>
            <Title>Could not verify AI Assistant prerequisites</Title>
            <Body>
                An unexpected error occurred while checking the MCP Server and TA installation:
                <br />
                <code>{health.message}</code>
                <br />
                <br />
                If this persists, check that the Splunk REST endpoint <code>/services/mcp</code>{' '}
                is reachable and that your session has permission to list installed apps.
            </Body>
            <ActionRow>
                {onRetry && <SecondaryButton onClick={onRetry}>Retry</SecondaryButton>}
            </ActionRow>
        </Card>
    );
};

export default MCPSetupWizard;
