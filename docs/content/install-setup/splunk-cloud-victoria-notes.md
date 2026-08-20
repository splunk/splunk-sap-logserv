# Splunk Cloud Victoria — Customer-Tier Admin Notes

Splunk Cloud Victoria (10.x and later) routes admin access through a different role model than Splunk Enterprise. This page covers the differences that affect Splunk for SAP LogServ installs on Splunk Cloud Victoria — what your customer-tier admin can and can't do, what we've done in the LogServ packages to make customer-tier admins productive, and what you'll need to coordinate with Splunk Cloud Support.

If you're installing on **Splunk Enterprise** (on-prem or BYOL), none of this page applies — Splunk Enterprise's `admin` role is the universal admin with no capability gaps to work around.

## :material-circle-box:{ .taiconcolor } Splunk Cloud Victoria role tiers

| Role | Who gets it | What it can do on this deployment |
|---|---|---|
| `sc_admin` | Reserved for Splunk Cloud Operations staff at Splunk Inc. | Full admin. Splunk Cloud customers typically do **not** see this role exposed in their stack's Settings → Access Controls → Roles list. |
| `sc_subadmin` | Customer's effective top admin role | Manages most knowledge objects + apps. May or may not include `admin_all_objects` depending on the stack's provisioning. |
| `power`, `user` | Standard non-admin roles | Search + dashboard view; cannot install or configure apps. |

**Verify which tier you have:** sign in to your Splunk Cloud Victoria URL → **Settings → Access Controls → Roles** → click the role assigned to your account → **Capabilities** tab. If you see `sc_admin` listed as an available role, your stack exposes it; if not, `sc_subadmin` is the top customer-side admin role.

**Verify whether your `sc_subadmin` has `admin_all_objects`:** in the same Capabilities tab, look for `admin_all_objects` in the assigned capabilities list. Some Splunk Cloud Victoria deployments grant it to `sc_subadmin` automatically; locked-down deployments do not. This single capability controls whether several REST endpoints accept your writes — see [Capability-gated endpoints below](#capability-gated-rest-endpoints).

## :material-circle-box:{ .taiconcolor } Capability-gated REST endpoints

Splunk's REST framework enforces some capability requirements server-side, independent of any per-object access control list. These gates affect what your `sc_subadmin` account can do on the LogServ packages:

| REST endpoint | Gate | LogServ usage |
|---|---|---|
| `/storage/passwords` | `edit_storage_passwords` (typically granted to `sc_subadmin`) | HEC audit-forwarder tokens, MCP bearer tokens (and LLM provider credentials in builds where the LLM path is enabled — not the published templates-only build) |
| `/storage/collections/data/<collection>` | None — collection-level metadata ACL only | AI Assistant settings + acks, topology layouts, dashboard refresh preferences |
| `/configs/conf-<name>/...` | **`admin_all_objects`** (hardcoded in the REST framework) | Historical AI Assistant settings storage — migrated to KV Store to dodge this gate |
| `/data/inputs/<service>` | `admin_all_objects` | UCC modular-input writes — the LogServ **Azure** and **GCP** add-ons ship `passSystemAuth = true` on every `[admin_external:*]` stanza so the input-CRUD handler runs in system context (applied at build time by each add-on's `additional_packaging.py`) |

The takeaway: **even with full metadata.meta write permission on an object, certain REST endpoints will return 403 to your `sc_subadmin` account if `admin_all_objects` isn't granted.** The LogServ packages have been built to either avoid these endpoints (KV Store, where possible) or work around them via system-context bypasses (`passSystemAuth`, where the admin_external pattern applies).

## :material-circle-box:{ .taiconcolor } What the LogServ packages do for customer-tier admins

These changes are baked into the current canonical tarballs in `release_binaries/`. You don't need to configure anything; they take effect automatically when you install on Splunk Cloud Victoria:

### :material-circle-box:{ .taiconcolor } `sc_subadmin` in `metadata/default.meta` write ACL

Both the LogServ App and the Data TA ship with `sc_subadmin` in their global write ACL: `access = read : [ * ], write : [ admin, sc_admin, sc_subadmin ]`. This grants `sc_subadmin` write access to every knowledge object in the app (saved searches, macros, lookups, eventtypes, tags, etc.) at the metadata layer.

The Data TA's `metadata/default.meta` is post-build-patched into the released tarball — UCC's stock build template would silently overwrite the source-level value with `[ admin, sc_admin ]`, so `additional_packaging.py` re-injects sc_subadmin after the UCC step. See [`tools/scripts/patch_data_ta_sc_subadmin_metadata.py`](https://github.com/splunk/splunk-sap-logserv/tree/main/tools/scripts) for the standalone repair script that can also patch an already-built Data TA tarball without re-running UCC.

### :material-circle-box:{ .taiconcolor } `edit_deployment_server` capability (not `admin_all_objects`)

The Data TA's `/splunk_ta_sap_logserv/deployment_push` REST handler is gated by `edit_deployment_server` — a Splunk-standard capability that's typically granted to `sc_subadmin` on Splunk Cloud Victoria. The earlier requirement of `admin_all_objects` would have blocked sc_subadmin from triggering deployment-server pushes; the change makes the in-app deployment-push UI usable for customer-tier admins.

### :material-circle-box:{ .taiconcolor } AI Assistant settings + T&C acks in KV Store

The AI Assistant's admin-controlled settings (`enabled`, `provider`, `default_model`, `tier`, `mcp_required`, audit forwarder config, etc.) and the legal-acknowledgement state for the two T&C modals (Enable AI Assistant; Disable Audit Forwarder) are stored in two KV Store collections:

- `logserv_ai_assistant_settings` — single row keyed `defaults`, holding every admin-controlled AI Assistant settings field
- `logserv_ai_assistant_acks` — one row per legal-stanza name, holding the acknowledged opt-in version, the choice, and its timestamp (the acknowledgement is recorded once per stanza for the deployment, not per user; the audit event records who acknowledged it)

KV Store endpoints are governed only by the collection-level metadata ACL — no `admin_all_objects` capability requirement. Both collections ship with `write : [ * ]` — write access is granted to every authenticated user at the ACL layer, because the KV Store endpoint has no capability gate to fall back on; admin-tier gating is enforced in the UI (`useIsAdmin`), not by the collection ACL. Without this design, sc_subadmin users on locked-down Splunk Cloud Victoria deployments would hit 403 on every Save Defaults click and every T&C modal Submit.

A one-shot migration helper in `App.tsx`'s mount effect copies pre-migration values from `local/ai_assistant_settings.conf` and `local/ai_assistant_acks.conf` into the new KV Store rows on first page load. Customers upgrading from a build that wrote settings to local conf-files don't lose their settings.

### :material-circle-box:{ .taiconcolor } Data TA Configuration saves fall back to the filesystem

The Data TA's **Configuration → Filters** and **Cloud Provider** tabs write their settings through splunktaucclib's REST persist. If that write returns 403 ("This operation is forbidden" — the `admin_all_objects` gate on `/configs/conf-*`), the handler falls back to writing `local/splunk_ta_sap_logserv_settings.conf` directly on the filesystem, so **Save succeeds for `sc_subadmin` accounts** (and hardened on-prem `admin` roles without `admin_all_objects`). The metadata write ACL still gates who may attempt the save. Note `passSystemAuth` is **not** honoured for UCC `[admin_external:*]` settings handlers — the filesystem fallback is what actually carries these saves.

### :material-circle-box:{ .taiconcolor } `useIsAdmin` recognizes `sc_admin` + `sc_subadmin`

The React UI's admin-gating hook (`hooks/useIsAdmin.ts`) recognizes `admin`, `sc_admin`, AND `sc_subadmin` as admin-tier roles. Without this expansion, the AI Assistant Settings page would render a 403 "Admin access required" fallback for any sc_subadmin user even when their role can do everything the page needs.

## :material-circle-box:{ .taiconcolor } Splunk MCP Server (App 7931) JWT audience requirement

This is a customer-side configuration item that's NOT controlled by anything in the LogServ packages.

Splunk Cloud Victoria's edge proxy auto-injects a JWT into every `/__raw/` splunkd request, derived from the user's session cookie. The Splunk MCP Server (Splunkbase App 7931) validates that JWT's `aud` claim and requires it to be `"mcp"`. Common Splunk Cloud Victoria default audiences (e.g., `"Demo"` on non-production stacks) cause every MCP request to return:

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "error": {
        "code": -32600,
        "message": "Invalid token audience: <whatever-your-jwt-has>"
    }
}
```

…which the LogServ App's MCP health probe surfaces as the **SETUP REQUIRED** banner in the AI Assistant.

See [Splunk MCP Setup → Splunk Cloud — JWT `aud` (audience) claim must be `mcp`](../ai-assistant/mcp-setup.md#splunk-cloud-jwt-aud-audience-claim-must-be-mcp) for the full diagnostic + remediation path. The short version: re-mint the MCP token with `audience=mcp`, OR open a Splunk Cloud Support ticket asking them to set the stack's MCP audience to `mcp`.

## :material-circle-box:{ .taiconcolor } Standalone repair script for the Data TA metadata patch

If you're managing your own Data TA tarball builds (rebuilding from source via UCC, or patching an already-deployed tarball without redeploying), you can apply the sc_subadmin metadata fix in two ways:

**1. Auto-applied on every UCC build.** `sap_logserv_package/splunk_ta_sap_logserv/additional_packaging.py` carries `patch_sc_subadmin_metadata()` which fires as the final job in `cleanup_output_files()`. Run `./build_logserv_ta.sh <version>` from the source tree — the patch lands automatically and the build output prints `[additional_packaging] Patched metadata/default.meta: added sc_subadmin to global write ACL.`

**2. Standalone repair against an extracted or packaged tarball.** Use [`tools/scripts/patch_data_ta_sc_subadmin_metadata.py`](https://github.com/splunk/splunk-sap-logserv/tree/main/tools/scripts):

```bash
# Against an extracted Data TA directory:
python3 tools/scripts/patch_data_ta_sc_subadmin_metadata.py /path/to/extracted/splunk_ta_sap_logserv

# Against a tarball (extracts, patches, repacks in place + .pre-sc_subadmin-patch.bak backup):
python3 tools/scripts/patch_data_ta_sc_subadmin_metadata.py --tarball /path/to/splunk_ta_sap_logserv-X.Y.Z.tar.gz
```

Both invocations are idempotent — running on already-patched input is a no-op.

## :material-circle-box:{ .taiconcolor } Splunk Cloud Support tickets you may need to file

| Symptom | Ticket request |
|---|---|
| AI Assistant SETUP REQUIRED banner; MCP requests return `Invalid token audience: <X>` | Ask Splunk Cloud Support to set the stack's MCP-audience claim to `mcp`, OR to grant your `sc_subadmin` role the ability to mint MCP tokens with arbitrary audiences |
| `sc_subadmin` cannot install custom apps (private-app vetting blocks them) | Standard Splunk Cloud private-app submission flow; out of scope for this guide |
| `sc_subadmin` needs `admin_all_objects` for some non-LogServ workflow | Coordinate with Splunk Cloud Support — they can grant it on a per-stack basis, but the LogServ packages are designed to not require it |

## :material-circle-box:{ .taiconcolor } Splunk Enterprise compatibility

Everything on this page is backwards-compatible with on-prem Splunk Enterprise. `sc_admin` and `sc_subadmin` are Splunk Cloud-only roles — Splunk Enterprise's `admin` role retains all write access. The MCP audience requirement applies only when the platform's edge proxy injects a JWT, which on-prem Splunk Enterprise doesn't do (cookie auth flows through `__raw` directly to splunkd). Enterprise admins see zero behavior change from any of these Cloud-targeted fixes.
