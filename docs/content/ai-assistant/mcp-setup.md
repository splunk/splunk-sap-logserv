# Splunk MCP Setup

The AI Assistant's tool-dispatch path runs on top of the [Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931). MCP — Model Context Protocol — is Anthropic's open standard for connecting LLMs to external tools and data; the Splunk MCP Server exposes Splunk's search-job + saved-search endpoints as MCP tools that any MCP-aware client can call. The LogServ App is the MCP client; the Splunk MCP Server is the MCP server; the LLM vendor (Anthropic / OpenAI / Azure / Bedrock) is the LLM.

## :material-circle-box:{ .taiconcolor } Prerequisites

- **Splunk 9.4.3 or later.**
- **[Splunk MCP Server (Splunkbase App 7931)](https://splunkbase.splunk.com/app/7931) v1.1.0 or later** installed on the **same search head** as the LogServ App. (The LogServ App's React UI calls MCP via the same Splunk Web session, so they need to share an HTTP host.)
- **Admin user role** to install the MCP Server app and configure its REST handlers.

!!! note "Splunk MCP TA gate currently bypassed"
    The app's hard-dependency check for a separate Splunk MCP TA is currently bypassed in code via a `SKIP_MCP_TA_CHECK` flag. As a result the only hard prerequisite the app enforces at runtime is the Splunk MCP Server (App 7931) itself.

### :material-lightning-bolt:{ .taiconcolor } Recommended companion: Splunk AI Assistant

[Splunk AI Assistant (Splunkbase App 200)](https://splunkbase.splunk.com/app/200) is the typical co-install for the Splunk MCP Server. It's **not a strict prerequisite** for the LogServ App's AI Assistant — the LogServ App uses only the core `splunk_run_saved_search` and `splunk_run_query` MCP tools, which work standalone. However:

- App 200 unlocks additional `saia_*`-prefixed MCP tools (e.g., SPL optimization helpers) that future LogServ releases may use.
- Installing it alongside the MCP Server follows Splunk's documented setup pattern.
- If you're already deploying the Splunk MCP Server, the marginal effort to add App 200 is small and avoids friction later.

## :material-circle-box:{ .taiconcolor } Install the Splunk MCP Server

Per [Splunkbase App 7931](https://splunkbase.splunk.com/app/7931)'s installation guide:

1. Download the MCP Server tarball from Splunkbase.
2. On the search head where the LogServ App lives, install via Splunk Web (**Apps → Install app from file**) or via CLI:
   ```bash
   /opt/splunk/bin/splunk install app /path/to/splunk-mcp-server.tar.gz
   ```
3. Restart Splunkd:
   ```bash
   sudo systemctl restart Splunkd
   ```
4. Verify the app is installed and the REST handler endpoint responds:
   ```bash
   curl -sk -u admin:<password> https://localhost:8089/services/mcp/health
   ```

If the health endpoint responds OK, the LogServ App's AI Assistant should detect MCP automatically on next page load.

## :material-circle-box:{ .taiconcolor } Authentication

### Cookie auth (default, recommended)

App 7931 v1.1.0 accepts cookie auth from the same Splunk Web session that's serving the React app. When the LogServ App calls the MCP server endpoint at `/en-US/splunkd/__raw/services/mcp` (the default), the browser includes the Splunk session cookie automatically; no bearer token needed.

This is the default and preferred configuration. No setup required beyond installing the MCP Server app — works on both HTTPS and HTTP Splunk; the browser handles the session cookie either way. (HTTPS is in fact preferred — Splunk's session cookies set the `Secure` and `SameSite=Lax` flags, which behave fully correctly only over HTTPS.)

### Bearer token (optional, OAuth-strict environments)

For customers with OAuth-strict MCP server configurations (where cookie auth is disabled at the server side), the LogServ App supports an optional bearer token. Admin pastes the token in [Settings → Splunk MCP](settings.md#splunk-mcp-tab) under realm `logserv_ai_assistant_mcp` name `bearer_token`. The LogServ App layers it on top of the cookie auth via `Authorization: Bearer <token>` header. On 401 the client invalidates the cached token and retries once.

#### :material-lightning-bolt:{ .taiconcolor } Splunk Cloud — JWT `aud` (audience) claim must be `mcp`

On Splunk Cloud (Victoria 10.x and later), the platform's edge proxy mints a JWT from the user's session and forwards it to splunkd as a Bearer token automatically — independent of whether you paste a bearer token in our Settings page. **The Splunk MCP Server validates the JWT's `aud` (audience) claim, and the only value it accepts is `mcp`.**

If the JWT your Splunk Cloud stack stamps has any other audience (a common default is `Demo` on freshly-provisioned non-production stacks), every MCP request returns:

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

…and the AI Assistant renders the **SETUP REQUIRED** banner because the health probe's `initialize` call gets that 403.

**Fix:** generate (or have your Splunk Cloud admin / Splunk Support generate) an MCP token with `aud = mcp`. The exact path depends on how your Splunk Cloud stack mints tokens:

- If your stack uses Splunk's `/services/authorization/tokens` endpoint, set `audience=mcp` when minting.
- If JWTs are stamped by the Cloud edge proxy (Victoria default), open a Splunk Cloud Support ticket asking them to set the stack's MCP audience to `mcp`.
- If your stack is fronted by an external SSO (Okta, Azure AD, etc.), configure the SSO's token-issuer to set `aud: "mcp"` on tokens destined for the MCP route.

Confirm by decoding the actual JWT being sent in your browser's Network tab (paste the Bearer token value into [jwt.io](https://jwt.io)) and checking the `aud` claim. If it's `mcp`, the audience is correct and your error is something else. If it's anything else, that's the misalignment.

This `aud=mcp` requirement is an App 7931 server-side configuration; the LogServ App itself is audience-agnostic — it just forwards whatever bearer token (if any) Splunk Cloud injects.

## :material-circle-box:{ .taiconcolor } Configuration in the LogServ App

Open Settings → AI Assistant → **General** and confirm:

- **`mcp_required`** = `true` (default). When false, MCP is bypassed and the chat operates in MCP-less chat mode (Claude streaming works, no tool dispatch). Useful for debugging the LLM-side flow without MCP. **Most customers leave this true.**
- **`mcp_server_url`** = blank (default — uses the scheme-relative `/en-US/splunkd/__raw/services/mcp`). Override only if your MCP server is at a non-default path or you're proxying through a different ingress.

Then in [Settings → Splunk MCP](settings.md#splunk-mcp-tab):

- **`bearer_token`** = blank if using cookie auth (default), or paste the token if your MCP server requires bearer auth.

Save the General tab. The Settings save records a config-changed audit event; the next page load picks up the new MCP URL / token.

## :material-circle-box:{ .taiconcolor } Health-Check + Setup Wizard

When the AI Assistant panel opens, it runs a health check against the configured MCP endpoint. Three possible outcomes:

| Health status | What renders |
|---|---|
| `ok` | Empty chat panel; ready for prompts. |
| `error` | MCPSetupWizard renders with diagnostic guidance (URL, last error, suggested fix). |
| `loading` | Spinner; transient. |

The setup wizard surfaces:

- The configured MCP URL.
- The last error (typically HTTP 404 if the endpoint path is wrong, 401 if auth is failing, network timeout if MCP isn't reachable).
- A **Retry** button that re-runs the health check.
- A link back to Settings → Splunk MCP to fix credentials.

## :material-circle-box:{ .taiconcolor } Common Issues

### "Stuck at health-check loading"

The health-check endpoint is hanging. Most common cause: the configured `mcp_server_url` points at a path the MCP Server app doesn't expose. Check via curl from the search head:

```bash
curl -sk -u admin:<pw> https://localhost:8089/services/mcp/health
```

If that 404s, the MCP Server app isn't installed correctly or the REST handler is misconfigured.

### "Invalid token audience" (Splunk Cloud)

The browser's Network tab shows the `POST /en-US/splunkd/__raw/services/mcp` request returning HTTP 403 with body:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Invalid token audience: <value>" } }
```

The JWT that Splunk Cloud's edge proxy stamps onto the request has an `aud` claim that App 7931 isn't configured to accept. **App 7931 requires `aud = mcp`.** See [Splunk Cloud — JWT `aud` (audience) claim must be `mcp`](#splunk-cloud-jwt-aud-audience-claim-must-be-mcp) above for the full fix. The short version: re-mint the MCP token (or have Splunk Cloud Support do it) with `audience=mcp`.

### "401 Unauthorized on every dispatch"

Cookie auth isn't working — possible causes:

- The Splunk Web session expired in the browser. Re-login; re-open the AI Assistant panel.
- The MCP Server is configured with bearer-only auth. Configure a bearer token in Settings → Splunk MCP.
- A reverse proxy in front of Splunk is stripping the session cookie. Check the proxy's cookie-forwarding config.

### "MCP Server returns valid responses but tool tiles are empty"

The MCP Server's response format doesn't match what the LogServ App expects. Most common cause: MCP Server version mismatch (need v1.1.0 or later). Check via the Splunk Apps page; upgrade if needed.

## :material-circle-box:{ .taiconcolor } MCP-less Chat Mode

For debugging or for specific use cases where you want LLM streaming without MCP, set `mcp_required = false` in Settings → General. The AI Assistant then operates in **chat-only mode**:

- The LLM vendor receives system primer + user message + history (no tool definitions).
- The AI cannot dispatch any Splunk searches — no `splunk_run_saved_search`, no `splunk_run_query`.
- Replies are conversational only — useful for "explain how X works" type questions, but not for any data-grounded investigation.
- A persistent orange-warning banner at the top of the chat reads: *"Chat-only mode — tool execution disabled (MCP not configured). The AI can answer questions but cannot run searches against your Splunk data."*

This mode is **distinct from the [Templates-only build variant](templates-only-build.md)**: chat-only mode has the LLM-driven path on, MCP off; templates-only has the LLM-driven path off, MCP on.
