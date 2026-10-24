# Splunk MCP Setup

The AI Assistant runs every search through the [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931), in every build and every configuration: predefined prompts dispatch their saved searches through it, so this page applies to every deployment that uses the AI Assistant. MCP (Model Context Protocol) is an open standard for connecting LLM applications to external tools and data. The Splunk MCP Server exposes Splunk's searches and saved searches as MCP tools; the LogServ App is the MCP client. (An LLM vendor also takes part, choosing the tools, only for free-form questions answered by a configured LLM provider; for predefined prompts the App calls the tools itself.)

For the whole turn-on procedure, see [Set Up the AI Assistant](enable.md).

## :material-circle-box:{ .taiconcolor } Prerequisites

- **Splunk 9.4.3 or later.**
- **[Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) 1.1.0 or later is required; 1.2.1 or later is recommended.** The predefined prompts run through the MCP Server's Run Saved Search tool, which first shipped in 1.1.0. Version 1.2.1 fixes SVD-2026-1004 (server-side request forgery through custom API tools; vendor advisory checked 2026-10-22). The App's own health check refuses only versions below 1.0.3 (the CVE-2026-20205 fix), so 1.0.3 to 1.0.5 pass it but every predefined prompt fails. There is no upper version limit; the newest version verified with the App is 2.0.0.
- **The same search head as the LogServ App.** The App calls the MCP Server from the browser through the same Splunk Web session, so both must be on the same Splunk Web host.
- **The `mcp_tool_execute` capability** on every role that will use the AI Assistant ([Roles and Capabilities](#roles-and-capabilities)).
- **An admin** to install the MCP Server app and grant the capability.

The Splunk MCP Server is the only MCP component the App checks for.

### :material-lightning-bolt:{ .taiconcolor } Recommended companion: Splunk AI Assistant

[Splunk AI Assistant (Splunkbase App 7245)](https://splunkbase.splunk.com/app/7245) is recommended alongside the Splunk MCP Server. It is **not a prerequisite** of the LogServ App's AI Assistant, which uses only the MCP Server's core `splunk_run_saved_search` and `splunk_run_query` tools. However:

- App 7245 adds `saia_*`-prefixed MCP tools (for example SPL optimization helpers) that future LogServ releases may use.
- Installing it alongside the MCP Server follows Splunk's documented setup pattern.
- If you are deploying the Splunk MCP Server anyway, adding App 7245 is little extra effort.

## :material-circle-box:{ .taiconcolor } Install the Splunk MCP Server

Follow the installation guide on [Splunkbase App 7931](https://splunkbase.splunk.com/app/7931). In short:

1. **Install the app** on the search head where the LogServ App runs:
    - **Splunk Enterprise:** **Apps → Find More Apps**, or download the package from Splunkbase and use **Apps → Install app from file**. From the command line: `$SPLUNK_HOME/bin/splunk install app /path/to/<package>.tgz`.
    - **Splunk Cloud Platform:** the way your stack installs other Splunkbase apps (**Apps → Find More Apps** where your stack offers it), or ask Splunk Cloud Support.
2. **Restart Splunk** if it asks you to (on Splunk Enterprise: **Settings → Server controls → Restart Splunk**, or your usual restart method).
3. **Check it is installed:** **Apps → Manage Apps** lists **Splunk MCP Server** (folder `Splunk_MCP_Server`), enabled, with its version.
4. **Grant `mcp_tool_execute`** to the roles that will use the AI Assistant ([below](#roles-and-capabilities)).

To check that the server answers, run this on a Splunk Enterprise search head (checked against MCP Server 1.1.0, whose `ping` method needs no capability):

```bash
curl -sk -u admin:<password> -X POST https://localhost:8089/services/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

A working server replies with a JSON-RPC result whose `message` is `pong`. The endpoint takes only POST requests, so opening it in a browser or with a plain `GET` returns HTTP 405 (`Method not allowed`).

The LogServ App's AI Assistant runs its own check each time its panel opens ([Health Check and Setup Wizard](#health-check-and-setup-wizard)).

## :material-circle-box:{ .taiconcolor } Roles and Capabilities

The Splunk MCP Server checks a capability of its own on every request the AI Assistant sends. Its `default/authorize.conf` (version 1.1.0) defines two:

| Capability | What it allows | Granted by default to |
|---|---|---|
| `mcp_tool_execute` | Connect to the MCP Server and run its tools. Every AI Assistant user needs it. | `admin`, `sc_admin` |
| `mcp_tool_admin` | Manage the MCP Server's tools, tokens and rate limits. Not needed to use the AI Assistant. | `admin`, `sc_admin` |

Add `mcp_tool_execute` to each role whose members will use the AI Assistant: **Settings → Roles → *role* → Capabilities** (the same on Splunk Cloud Platform), or `mcp_tool_execute = enabled` under `[role_<name>]` in `authorize.conf`. Only `admin` and `sc_admin` hold it by default (and roles that import them), so `power`, `user` and, unless it imports one of those two, a delegated-admin role such as `sc_subadmin` need the grant. A user without it is refused at the first request with HTTP 403 and `User lacks required mcp_tool_execute capability`, and the AI Assistant panel shows its **Setup required** card.

Two more capabilities decide what else a user's AI Assistant can do, because the App works in the browser as the signed-in user:

- **Being audited** needs `edit_log_alert_event` or `edit_tcp` ([Who Can Write Audit Events](audit-log.md#who-can-write-audit-events)).
- **Free-form questions** need the user's role to read the provider credential from Splunk's password store (`list_storage_passwords`, which `admin` holds); see [Provider Credentials Tab](settings.md#provider-credentials-tab).

Changing the AI Assistant's settings needs a role named exactly `admin`, `sc_admin` or `sc_subadmin` ([Application Settings](settings.md#who-can-open-the-page)).

## :material-circle-box:{ .taiconcolor } Authentication

### Cookie auth (default, recommended)

The MCP Server (verified with 1.1.0) accepts the Splunk Web session of the signed-in user. When the LogServ App calls the default endpoint `/en-US/splunkd/__raw/services/mcp`, the browser sends the user's Splunk session cookie, so no bearer token is needed.

This is the default and preferred configuration; nothing needs setting up beyond installing the MCP Server and granting `mcp_tool_execute`. It works over HTTPS and HTTP. HTTPS is preferred: Splunk's session cookies set the `Secure` and `SameSite=Lax` flags, which behave fully correctly only over HTTPS.

### Bearer token (optional, OAuth-strict environments)

For an MCP Server configured to refuse cookie auth, the LogServ App can send a bearer token. An admin pastes it in [Settings → AI Assistant → Splunk MCP](settings.md#splunk-mcp-tab) (**Bearer Token**, realm `logserv_ai_assistant_mcp`, name `bearer_token`). The App adds it as an `Authorization: Bearer <token>` header on top of the cookie. On HTTP 401 the App drops its cached token and retries once.

#### :material-lightning-bolt:{ .taiconcolor } Splunk Cloud — JWT `aud` (audience) claim must be `mcp`

This is a customer-side configuration item: nothing in the LogServ packages controls it, and the LogServ App is audience-agnostic (it forwards whatever bearer token, if any, is sent).

On Splunk Cloud Platform (observed on Victoria Experience stacks), the platform's edge proxy turns the user's session into a JWT and passes it to splunkd as a bearer token on every `/__raw/` request, whether or not you paste a bearer token in the App's Settings page. **The Splunk MCP Server checks the JWT's `aud` (audience) claim and accepts the token only when that claim is `mcp`, or a list that includes `mcp`** (checked in version 1.1.0). Splunk Enterprise has no such edge proxy, so this does not apply there: the session cookie reaches splunkd directly.

If the JWT your Splunk Cloud stack stamps has any other audience (a common default on freshly provisioned non-production stacks is `Demo`), every MCP request returns HTTP 403 with:

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "error": {
        "code": -32600,
        "message": "Invalid token audience: <whatever-the-jwt-has>"
    }
}
```

The AI Assistant then shows its **Setup required** card, because the health check's first request (`initialize`) fails.

**Fix:** get an MCP token with `aud = mcp`, from your Splunk Cloud admin or Splunk Cloud Support. The path depends on how your stack mints tokens:

- If your stack uses Splunk's `/services/authorization/tokens` endpoint, set `audience=mcp` when minting.
- If JWTs are stamped by the Cloud edge proxy (the Victoria default), open a Splunk Cloud Support ticket asking them to set the stack's MCP audience to `mcp`.
- If your stack is fronted by an external SSO (Okta, Azure AD, etc.), configure the SSO's token issuer to set `aud: "mcp"` on tokens destined for the MCP route.

To confirm, decode the JWT your browser sends (the Bearer value of the `POST /en-US/splunkd/__raw/services/mcp` request in the browser's Network tab) with a JWT decoder you trust, and read its `aud` claim. If it is `mcp`, the audience is right and the error is something else.

## :material-circle-box:{ .taiconcolor } Configuration in the LogServ App

Open **Settings → AI Assistant → General** and confirm:

- **MCP Required** (`mcp_required`) is on (the default). When off, MCP is bypassed and the chat runs in [MCP-less chat mode](#mcp-less-chat-mode), which needs a configured LLM provider credential (LLM streaming with no searches). Where no credential is configured, or **Templates-only mode** is on, MCP is the only path that runs anything, so turning this off leaves the assistant unable to run anything. **Most customers leave it on.**
- **MCP Server URL** (`mcp_server_url`) is blank (the default: `/en-US/splunkd/__raw/services/mcp` on this Splunk instance). Set it only if your MCP Server is at another path or you reach it through another ingress.
- **MCP request timeout (seconds)** (`mcp_timeout_seconds`, default 60) covers your slowest prompt; see [Application Settings](settings.md#feature).

Then on [Settings → AI Assistant → Splunk MCP](settings.md#splunk-mcp-tab), leave **Bearer Token** empty for cookie auth (the default), or store the token if your MCP Server requires bearer auth.

Click **Save Defaults** on the General sub-tab; the next page load picks up the new URL and token. Changing the MCP settings records no audit event; [General Tab](settings.md#general-tab) lists the saves that do.

## :material-circle-box:{ .taiconcolor } Health Check and Setup Wizard

Each time the AI Assistant panel opens with **MCP Required** on, the App checks the configured MCP endpoint: it sends the MCP `initialize` request, then compares the version the server reports with the minimum. Until the check passes, the panel shows a card instead of the chat:

| What the panel shows | Cause | What to do |
|---|---|---|
| The chat, with **Browse prompts** | The check passed. | Nothing. |
| **Checking AI Assistant prerequisites…** | The check is running. | Wait; it ends when the request answers or the **MCP request timeout** passes. |
| **Setup required**: *AI Assistant requires the Splunk MCP Server* | The `initialize` request failed, for any reason: the MCP Server is not installed or not enabled, the URL is wrong, the user lacks `mcp_tool_execute` (HTTP 403), the JWT audience is wrong (HTTP 403, Splunk Cloud), the session expired (HTTP 401), or the request timed out. The card does not say which. | Check, in this order, [Roles and Capabilities](#roles-and-capabilities), [Install the Splunk MCP Server](#install-the-splunk-mcp-server), **MCP Server URL**, and the [JWT audience](#splunk-cloud-jwt-aud-audience-claim-must-be-mcp). The browser's Network tab shows the status and message of the `POST …/services/mcp` request. Then click **Re-check**. |
| **Security upgrade required**: *Splunk MCP Server v… is vulnerable* | The server reports a version below 1.0.3 (CVE-2026-20205). | Upgrade the Splunk MCP Server to 1.1.0 or later (1.2.1 or later recommended), then click **Re-check**. |
| **Health check error**: *Could not verify AI Assistant prerequisites* | An unexpected error; the card shows its message. | Check that `/services/mcp` is reachable and the user's session is valid, then click **Retry**. |

The **Setup required** and **Security upgrade required** cards also carry a link to [Splunkbase App 7931](https://splunkbase.splunk.com/app/7931). To change the URL or the bearer token, open [Settings → AI Assistant](settings.md) directly; the cards do not link there.

## :material-circle-box:{ .taiconcolor } Common Issues

### "Stuck at Checking AI Assistant prerequisites"

The check is waiting on a request that does not answer. The most common cause is an **MCP Server URL** that points at a host or path that does not respond. Leave the field blank to use the default, and check that the server answers with the `ping` request in [Install the Splunk MCP Server](#install-the-splunk-mcp-server). If that fails too, the MCP Server app is not installed or not enabled.

### "User lacks required mcp_tool_execute capability"

The browser's Network tab shows the `POST /en-US/splunkd/__raw/services/mcp` request returning HTTP 403 with that message, and the panel shows **Setup required**. Grant `mcp_tool_execute` to one of the user's roles ([Roles and Capabilities](#roles-and-capabilities)), then have the user reload the page.

### "Invalid token audience" (Splunk Cloud)

The browser's Network tab shows the `POST /en-US/splunkd/__raw/services/mcp` request returning HTTP 403 with body:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Invalid token audience: <value>" } }
```

The JWT that Splunk Cloud's edge proxy puts on the request has an `aud` claim the MCP Server does not accept: **it requires `aud = mcp`.** See [Splunk Cloud — JWT `aud` (audience) claim must be `mcp`](#splunk-cloud-jwt-aud-audience-claim-must-be-mcp) above. In short: have the MCP token re-minted with `audience=mcp`, or ask Splunk Cloud Support to set the stack's MCP audience to `mcp`.

### "401 Unauthorized on every request"

Cookie auth is not working. Possible causes:

- The Splunk Web session expired in the browser. Sign in again and reopen the AI Assistant panel.
- The MCP Server is configured for bearer auth only. Store a bearer token on **Settings → AI Assistant → Splunk MCP**.
- A reverse proxy in front of Splunk strips the session cookie. Check the proxy's cookie forwarding.

### "The panel opens, but predefined prompts fail or their tiles stay empty"

The MCP Server is older than 1.1.0 (1.0.3 to 1.0.5 pass the App's health check but have no Run Saved Search tool), or that tool is turned off in the MCP Server's own tool settings. Upgrade to 1.1.0 or later (1.2.1 or later recommended), or turn the tool on, as the MCP Server's documentation describes.

## :material-circle-box:{ .taiconcolor } MCP-less Chat Mode

!!! warning "Needs a configured LLM provider credential"
    Chat-only mode relies on LLM streaming, which works only once an admin has configured an [LLM provider credential](settings.md#provider-credentials-tab). Where none is configured, or **Templates-only mode** is on, or a compile-time [templates-only build](templates-only-build.md) is installed, turning **MCP Required** off leaves the panel with nothing that works.

For debugging, or where you want LLM streaming without MCP, turn **MCP Required** off on **Settings → AI Assistant → General**. The AI Assistant then runs in **chat-only mode**:

- The LLM vendor receives the system primer, the user message and the history (no tool definitions).
- The AI cannot run any Splunk search: no `splunk_run_saved_search`, no `splunk_run_query`, and no prompt browser.
- Replies are conversational only: useful for "explain how X works" questions, not for any investigation of your data.
- A persistent orange warning banner at the top of the chat reads: *"Chat-only mode — tool execution disabled (MCP not configured). The AI can answer questions but cannot run searches against your Splunk data."*

This mode is **distinct from Templates-only mode** ([Restricting the LLM Path](templates-only-build.md)): chat-only mode has the LLM path on and MCP off; Templates-only mode has the LLM path off and MCP on.
