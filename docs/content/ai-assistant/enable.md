# Set Up the AI Assistant

The AI Assistant ships turned off: until an admin turns it on, the LogServ App shows no **AI Assistant** button, panel or route. This page takes you from an installed LogServ App to a working predefined prompt. Use it after the LogServ App is installed and its dashboards show your data ([Install the App and Seed the Dashboards](../logserv-app/installation.md)).

The predefined prompts need no LLM provider and no vendor credential. Free-form questions, which do use an LLM vendor, are an optional extra at the end.

### :material-circle-box:{ .taiconcolor } Before You Start

- **The LogServ App** is installed on the search head, and the dashboards show data.
- **You hold a role named exactly `admin`, `sc_admin` or `sc_subadmin`.** Only those three role names open the LogServ App's **Settings** page; a delegated-admin role with any other name gets **403 — Admin access required** ([Application Settings](settings.md#who-can-open-the-page)).
- **You can install apps and edit roles** on the search head (on Splunk Cloud Platform, as `sc_admin` or with the help of Splunk Cloud Support).

### :material-circle-box:{ .taiconcolor } The Steps at a Glance

1. [Install the Splunk MCP Server](#1-install-the-splunk-mcp-server)
2. [Grant mcp_tool_execute to the roles that will use the AI Assistant](#2-grant-mcp_tool_execute-to-the-roles-that-will-use-the-ai-assistant)
3. [Decide who is audited and who can read the audit trail](#3-decide-who-is-audited-and-who-can-read-the-audit-trail)
4. [Turn on the AI Assistant and answer both acknowledgements](#4-turn-on-the-ai-assistant-and-answer-both-acknowledgements)
5. [Optional: turn on Templates-only mode](#5-optional-turn-on-templates-only-mode)
6. [Backfill the dashboard data](#6-backfill-the-dashboard-data)
7. [Run a predefined prompt and find its audit event](#7-run-a-predefined-prompt-and-find-its-audit-event)

<br>

### :material-circle-box:{ .taiconcolor } 1. Install the Splunk MCP Server

The AI Assistant runs every search through the <a href="https://splunkbase.splunk.com/app/7931" target="_blank">Splunk MCP Server (Splunkbase App 7931)</a>, a separate Splunk app. Installing the LogServ App does not bring it in.

- **Version:** 1.1.0 or later is required: the predefined prompts use the MCP Server's Run Saved Search tool, which first shipped in 1.1.0. **1.2.1 or later is recommended**, because it fixes SVD-2026-1004 (server-side request forgery through custom API tools). The App's own check refuses only versions below 1.0.3 (the CVE-2026-20205 fix) and sets no upper limit; the newest version verified with it is 2.0.0.
- **Where:** the same search head as the LogServ App. The App calls the MCP Server from the browser through the same Splunk Web session.

Install it the way you install any Splunkbase app: on Splunk Enterprise, **Apps → Find More Apps**, or download it from Splunkbase and use **Apps → Install app from file**; on Splunk Cloud Platform, the way your stack installs other Splunkbase apps (**Apps → Find More Apps** where your stack offers it), or ask Splunk Cloud Support. Restart Splunk if it asks you to. Details and a check that the server answers: [Splunk MCP Setup](mcp-setup.md#install-the-splunk-mcp-server).

**Done when:** **Apps → Manage Apps** lists **Splunk MCP Server** (`Splunk_MCP_Server`), enabled, at version 1.1.0 or later.

<br>

### :material-circle-box:{ .taiconcolor } 2. Grant mcp_tool_execute to the Roles That Will Use the AI Assistant

The MCP Server checks a capability of its own on every request the AI Assistant sends. Version 1.1.0 defines two, in its `default/authorize.conf`:

| Capability | What it allows | Granted by default to |
|---|---|---|
| `mcp_tool_execute` | Connect to the MCP Server and run its tools. Every AI Assistant user needs it. | `admin`, `sc_admin` |
| `mcp_tool_admin` | Manage the MCP Server's tools, tokens and rate limits. Not needed to use the AI Assistant. | `admin`, `sc_admin` |

Add `mcp_tool_execute` to each role whose members will use the AI Assistant: **Settings → Roles → *role* → Capabilities**, select `mcp_tool_execute`, and save (on Splunk Cloud Platform, the same page). In `authorize.conf` the same grant is `mcp_tool_execute = enabled` under `[role_<name>]`. Only `admin` and `sc_admin` hold it by default (and roles that import them), so `power`, `user` and, unless it imports one of those two, a delegated-admin role such as `sc_subadmin` need the grant.

A user without it is refused at the MCP Server's first request (HTTP 403, `User lacks required mcp_tool_execute capability`), and the AI Assistant panel shows its **Setup required** card even though the MCP Server is installed.

**Done when:** every role that will use the AI Assistant holds `mcp_tool_execute`, directly or through a role it imports.

<br>

### :material-circle-box:{ .taiconcolor } 3. Decide Who Is Audited and Who Can Read the Audit Trail

Every predefined prompt, free-form call, refusal and admin acknowledgement is written to the `logserv_ai_assistant_audit` index. Settle three things before users start:

1. **The audit index exists on the indexer tier.** The Data TA defines it, but outside a single instance you create it yourself, with the retention you need: [Create the Indexes](../install-setup/install-ta.md#1-create-the-indexes). An audit event sent to an index that does not exist is dropped.
2. **Who is audited.** Each user's browser writes that user's audit events, and Splunk accepts the write only from a role that holds `edit_log_alert_event` or `edit_tcp`. Of Splunk's default roles, `admin` holds both, `power` holds `edit_log_alert_event` and `user` holds neither, so users whose only role is `user` are not audited (their AI Assistant panel says so). To audit them, give them a role with `edit_log_alert_event`, the narrower of the two: [Who Can Write Audit Events](audit-log.md#who-can-write-audit-events).
3. **Who can read the audit trail.** A role whose allowed indexes contain `*` can search the audit index, and Splunk's default `user` role allows `*`. To keep the trail to its reviewers, narrow those roles: [Restricting Who Can Read the Audit Index](audit-log.md#restricting-who-can-read-the-audit-index).

Also decide whether to forward a copy of every audit event to a separately run Splunk instance or SIEM, which is what makes the trail tamper-evident: [HEC Forwarder](audit-log.md#hec-forwarder). Two limits apply. The destination's HTTP Event Collector must accept cross-origin requests from your Splunk Web address, because the browser sends the copy. And the browser must read the forwarder's HEC token from Splunk's password store, which by default only admins can do: for other users the copy fails and an `audit_forwarder_failure` event is written to the local index instead. If you leave forwarding off, step 4 asks you to acknowledge that.

**Done when:** the audit index exists, and you know which roles are audited and which can read the trail.

<br>

### :material-circle-box:{ .taiconcolor } 4. Turn On the AI Assistant and Answer Both Acknowledgements

1. In the LogServ App, open **Settings** in the navigation rail (near the bottom, above **About**). The **Application Settings** page opens on its **AI Assistant** tab, **General** sub-tab.
2. Under **Feature**, select **Enable AI Assistant**. Leave **MCP Required** on (the default).
3. Click **Save Defaults**.
4. The **AI Assistant — Liability terms** dialog opens. Read it and click **I accept (record Yes and enable)**.
5. With audit forwarding off (the default), the **Audit log integrity** dialog opens next. It explains that without the forwarder the local audit index is the only record, and a host-root admin can edit it. Click **I accept (record Yes and save)**.

The save then completes, and the **AI Assistant** button appears at the right end of the header's second row without a page reload. Both answers are recorded with your user name, as `ai_assistant_enable_acceptance` and `forwarder_disabled_acceptance` audit events.

- **I do not accept** in either dialog stops the save, and the AI Assistant stays off. The answer is recorded too. A No on the **Audit log integrity** dialog is recorded at its current version, so the next save that turns the AI Assistant on asks only the liability terms again, and then saves with forwarding off; that dialog comes back only when its terms change or a save turns forwarding from on to off.
- The liability dialog appears every time the AI Assistant is turned on, and again when its terms change. The audit-log integrity dialog appears again when its terms change, and whenever a save turns forwarding off.

Details: [Legal Acknowledgement Modals](settings.md#legal-acknowledgement-modals).

**Done when:** the **AI Assistant** button shows in the header.

<br>

### :material-circle-box:{ .taiconcolor } 5. Optional: Turn On Templates-only Mode

To offer only the predefined prompts and keep the free-form, LLM-driven path off, select **Templates-only mode** on the same **General** sub-tab and click **Save Defaults**. The chat input becomes read-only, the Power Mode toggle and the model picker are hidden, the **Provider Credentials** sub-tab is hidden, and an info banner explains the mode. Any admin can turn it off again. Where the restriction must not be reversible, see [Restricting the LLM Path](templates-only-build.md).

<br>

### :material-circle-box:{ .taiconcolor } 6. Backfill the Dashboard Data

About half of the predefined prompts read the same hourly rollups as the dashboards. Until those rollups are backfilled, these prompts return results only for the hours since the App was installed. If you have not run the backfill yet, run it now: [Backfilling on first install](../logserv-app/dashboard-data.md#backfilling-on-first-install).

<br>

### :material-circle-box:{ .taiconcolor } 7. Run a Predefined Prompt and Find Its Audit Event

1. Click **AI Assistant** in the header. The panel opens beside the dashboard.
    - If it shows a **Setup required**, **Security upgrade required** or **Health check error** card instead of the chat, see [Health Check and Setup Wizard](mcp-setup.md#health-check-and-setup-wizard).
2. Click **Browse prompts** below the chat input. Pick a **Time range** (the default is **Last 24 hours**) and a tab: **Dashboard Focused** (prompts for the dashboard you have open), **SAP Basis**, **Security** or **Operations**.
3. Click a prompt. Its result appears as a tile in the right pane, and a **How to read this result** card appears in the chat.
4. Click **Audit this session** in the banner at the top of the panel. The list shows a `local_only` event for the prompt you ran.
5. Open **Settings → AI Assistant → Audit Log**. With a time range that covers the last few minutes, the same `local_only` event is listed, now read from the index.

Repeat steps 1-5 as a user who holds only an analyst role. That checks the `mcp_tool_execute` grant of step 2, and whether that role is audited (step 3). If the analyst's event is missing from the index while the panel shows **Audit events are not being written**, the role lacks `edit_log_alert_event` and `edit_tcp`.

**Done when:** a predefined prompt returns a tile for an analyst user, and, if that user's role is audited (step 3), its `local_only` event is in the audit index.

<br>

### :material-circle-box:{ .taiconcolor } Optional: Free-form Questions with an LLM Provider

If you turned on **Templates-only mode** in step 5, turn it off first: while it is on, typed questions are refused and the **Provider Credentials** sub-tab is hidden.

The shipped default provider is **Mock (development only)**: a typed question gets a canned reply, and no vendor is contacted. To answer free-form questions with a real LLM:

1. Choose a [privacy tier](privacy-tiers.md) first. Tier 1, the default, sends the vendor two numbers per search; Tier 2 also sends aggregated values from your events.
2. Store the provider's credential on **Settings → AI Assistant → Provider Credentials** ([Provider Credentials Tab](settings.md#provider-credentials-tab)).
3. Select the provider as **Active Provider**, pick a **Default Model**, and click **Save Defaults**. The liability dialog of step 4 does not appear for this change.

Each user's browser reads the provider credential from Splunk's password store when that user sends a question, so a user whose role cannot read stored passwords (Splunk's `list_storage_passwords` capability, which `admin` holds) gets an error instead of an answer. See [Free-form Prompts](free-form-prompts.md).

### :material-circle-box:{ .taiconcolor } Turning It Off

Clear **Enable AI Assistant** on the **General** sub-tab and click **Save Defaults**. The **AI Assistant** button disappears from your page at once, and from other users' pages at their next page load. A page without the button runs no MCP check. The settings you saved are kept for the next time it is turned on.

## :material-circle-box:{ .cboxmove } Next Steps

- [Predefined Prompts](predefined-prompts.md): the prompt catalog and what each tile shows.
- [Audit Log](audit-log.md): the categories, the viewer and the searches for reviewing the trail.
- [Application Settings](settings.md): every setting on the page.
- [Restricting the LLM Path](templates-only-build.md): when the free-form path must stay off.
- Back to the [Deployment Roadmap](../getting-started/roadmap.md).
