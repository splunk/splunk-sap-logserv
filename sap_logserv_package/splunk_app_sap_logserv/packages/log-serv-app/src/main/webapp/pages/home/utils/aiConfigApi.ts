/**
 * aiConfigApi — reader/writer for the admin-managed AI Assistant defaults
 * (provider, model, tier, enabled, mcp_required, mcp_server_url, etc.).
 *
 * Storage (session 042 / Option D):
 *   PRIMARY: KV Store collection `logserv_ai_assistant_settings`, single
 *   row keyed `defaults`. KV Store endpoints are gated only by the
 *   collection-level metadata ACL — no `admin_all_objects` capability
 *   requirement — so sc_subadmin users on locked-down Splunk Cloud
 *   Victoria deployments can save without the capability escalation that
 *   `/configs/conf-X/` writes require.
 *
 *   FALLBACK: `default/ai_assistant_settings.conf [defaults]` via the
 *   standard `configs/conf-<name>` REST endpoint. Used for two purposes:
 *     1. Fresh install before any KV Store row exists — returns the
 *        baseline shipped values so the app renders sensibly.
 *     2. Upgrade migration — `migrateConfFileSettingsToKvStore()` copies
 *        the conf-file values into KV Store on first load so customers
 *        who customized in a prior build don't lose their settings.
 *
 * Auth model:
 *   - Splunk Web session cookie via `credentials: 'same-origin'`
 *   - `X-Requested-With: XMLHttpRequest` header (always)
 *   - `X-Splunk-Form-Key: <csrf>` header on every mutating request (POST)
 *   - Read: any authenticated user with read on the collection (ACL is
 *     `read : [ * ]`), so non-admin users can fetch the active provider /
 *     tier on app load.
 *   - Write: any authenticated user with write on the collection (ACL is
 *     `write : [ * ]`). Single-row convention (_key = "defaults") means
 *     all admin saves overwrite the same row — no per-user fragmentation.
 *     The admin-gating happens client-side via useIsAdmin; the server-
 *     side ACL is intentionally permissive to dodge the capability gate.
 *
 * Cache: `readAIConfig()` results are memoized in-process to avoid one
 * REST round-trip per render. Call `clearAIConfigCache()` after a
 * successful write to force a re-read on the next access.
 *
 * Build 240 / session 042. Prior to build 240 this module wrote to
 * `configs/conf-ai_assistant_settings` — see git history for the conf-
 * file implementation.
 *
 * Build 300 / session 092 — TEMPLATES_ONLY interaction:
 *   In a templates-only build (`yarn build:templates-only`) the compile-
 *   time flag FORCES `templates_only_mode` true no matter what either
 *   storage source says. This module is the single chokepoint for that:
 *   `parseRawContent` normalizes BOTH the KV Store row and the conf-file
 *   stanza, and `DEFAULT_AI_CONFIG` is the last-resort fallback when both
 *   reads fail — so forcing in those two places covers every read path
 *   (current and future) with no per-consumer guard.
 *
 *   Why the shipped conf default alone is NOT sufficient: KV Store WINS
 *   over the conf (see `readAIConfig`), so a customer upgrading from a
 *   full-LLM build — whose KV row already holds `templates_only_mode = 0`
 *   — would keep the LLM path enabled in a templates-only build. And if
 *   both REST reads transiently fail, the un-forced `DEFAULT_AI_CONFIG`
 *   would do the same.
 *
 *   In a regular build the flag is the literal `false`, so `false || x`
 *   collapses to `x` under webpack dead-code elimination: zero behavior
 *   change and zero runtime cost on the full-LLM line.
 */

import { TEMPLATES_ONLY } from '../buildFlags';

const APP_NAMESPACE = 'splunk_app_sap_logserv';

// --- KV Store endpoint ---
const COLLECTION = 'logserv_ai_assistant_settings';
const SETTINGS_KEY = 'defaults';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;
const KV_ROW_URL = `${KV_BASE}/${encodeURIComponent(SETTINGS_KEY)}`;

// --- Conf-file fallback endpoint (read-only) ---
const CONF_NAME = 'ai_assistant_settings';
const CONF_STANZA = 'defaults';
const CONF_STANZA_URL =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/configs/conf-${CONF_NAME}/${encodeURIComponent(CONF_STANZA)}`;

export type ProviderName =
    | 'mock'
    | 'anthropic'
    | 'openai'
    | 'azure_openai'
    | 'bedrock'
    | 'ollama';

export type PrivacyTier = 0 | 1 | 2;

export interface AIConfigSettings {
    enabled: boolean;
    /** Runtime templates-only mode. When true, the LLM-driven free-form
     *  path is disabled — chat input read-only, model picker + Power
     *  Mode toggle hidden, Provider Credentials Settings tab hidden, an
     *  info banner explains the mode. Replaces the previous compile-
     *  time `TEMPLATES_ONLY` build flag. Admin-controlled via Settings
     *  → AI Assistant → General → Templates-only mode toggle. */
    templates_only_mode: boolean;
    provider: ProviderName;
    default_model: string;
    tier: PrivacyTier;
    mcp_required: boolean;
    mcp_server_url: string;
    /** Client-side MCP request timeout, in SECONDS. Each MCP request
     *  (tool dispatch, saved-search run, health probe) is aborted
     *  browser-side after this many seconds — the source of the
     *  "signal is aborted without reason" chat error when a prompt's
     *  saved search legitimately runs long on a high-ingest instance.
     *  MCPClient reads this per-call (like `mcp_server_url`) and
     *  clamps it to 5–600. Separate from the MCP server's own REST
     *  timeout (mcp.conf [server] timeout); the effective ceiling is
     *  the lower of the two. Default 60. */
    mcp_timeout_seconds: number;
    /** Per-user free-form prompt rate limit (rolling 1-hour window).
     *  0 = disabled. Maps to OWASP LLM10 (Unbounded Consumption).
     *  Build 80 / session 019. */
    rate_limit_per_hour: number;
    /** Per-chat-session cap on total MCP tool dispatches across all
     *  messages. 0 = disabled. Maps to OWASP LLM06 (Excessive Agency).
     *  Build 88 / session 020. */
    tool_calls_per_session_cap: number;
    /** Per-user daily vendor spend cap in USD (resets at local
     *  midnight). 0 = disabled. Maps to OWASP LLM10 (Unbounded
     *  Consumption) — cost half. Build 89 / session 020. */
    daily_spend_cap_usd: number;
    /** Tier 2 PII column redaction. When true (default), categorical
     *  values whose column name matches an identifier pattern (email,
     *  user, *_ip, mac, account) get replaced with a stable
     *  `<redacted-XXXXXXX>` tag in the AI-bound summary. Cardinality +
     *  frequency are preserved; identifiers don't leave the browser.
     *  Maps to OWASP LLM02 (Sensitive Information Disclosure).
     *  Build 94 / session 022. */
    tier2_pii_redaction: boolean;
    /** When true, also redact host / hostname columns. Default false —
     *  Splunk dashboards routinely show hostnames. Build 94. */
    tier2_redact_hostnames: boolean;
    /** Local Splunk index that receives every audit event AuditWriter
     *  posts. Default `ai_assistant_audit` matches the LogServ Index
     *  App's default indexes.conf and the `sap_logserv_audit_idx_macro`
     *  search-time macro definition. Customers who rename the audit
     *  index must update the macro definition in lockstep so the in-app
     *  Audit Log Viewer + user-written queries find the events. */
    audit_index_name: string;
    /** When true, every audit event POSTed to the local audit index
     *  is ALSO POSTed to the HEC endpoint configured below. Tamper-
     *  evidence via off-host duplication. Build 98 / session 022. */
    audit_forwarder_enabled: boolean;
    /** Destination HEC base URL (e.g. `https://siem.example.com:8088`).
     *  Empty when the forwarder is disabled. Build 98. */
    audit_forwarder_url: string;
    /** Optional remote index name. Empty = use the HEC token's default. */
    audit_forwarder_index: string;
    /** Source field stamped on forwarded events. */
    audit_forwarder_source: string;
    /** Comma-separated list of Splunk role names whose members are
     *  granted the AI Assistant "Power Mode" toggle. Empty means
     *  no one. Maps to OWASP LLM06 (Excessive Agency — gated more
     *  aggressive AI behavior to authorized users only).
     *  Build 166 / session 028. */
    power_user_roles: string;
    /** Dynamic model discovery. When true (default), the per-provider
     *  model list refreshes itself from the vendor's model-listing API
     *  (metadata-only GET with the stored credential) and merges with
     *  the shipped static baseline. When false, zero vendor list calls
     *  fire and the picker shows the static baseline only.
     *  Session 079 / build 275. */
    model_discovery_enabled: boolean;
}

/** Safe in-process fallback used when the conf can't be read (e.g.,
 *  fresh install before any save, or transient REST failure). Mirrors
 *  the `default/ai_assistant_settings.conf` shipped values. */
export const DEFAULT_AI_CONFIG: AIConfigSettings = {
    enabled: false,
    // Build 300 — in a templates-only build this fallback must also be
    // true, otherwise a transient failure of BOTH reads (KV Store and
    // conf) would hand back a config with the LLM path enabled. In a
    // regular build the flag is the literal `false`, i.e. unchanged.
    templates_only_mode: TEMPLATES_ONLY,
    provider: 'mock',
    default_model: 'mock-fast',
    tier: 1,
    mcp_required: true,
    mcp_server_url: '',
    mcp_timeout_seconds: 60,
    rate_limit_per_hour: 30,
    tool_calls_per_session_cap: 100,
    daily_spend_cap_usd: 50.0,
    tier2_pii_redaction: true,
    tier2_redact_hostnames: false,
    audit_index_name: 'ai_assistant_audit',
    audit_forwarder_enabled: false,
    audit_forwarder_url: '',
    audit_forwarder_index: '',
    audit_forwarder_source: 'logserv_ai_assistant_remote',
    power_user_roles: '',
    model_discovery_enabled: true,
};

const VALID_PROVIDERS: ReadonlyArray<ProviderName> = [
    'mock',
    'anthropic',
    'openai',
    'azure_openai',
    'bedrock',
    'ollama',
];

const isProvider = (s: unknown): s is ProviderName =>
    typeof s === 'string' &&
    (VALID_PROVIDERS as ReadonlyArray<string>).includes(s);

const isTier = (n: unknown): n is PrivacyTier => n === 0 || n === 1 || n === 2;

/** Coerce a raw record from EITHER source (KV Store row OR conf-file stanza
 *  content block) into the strongly-typed `AIConfigSettings`. Both sources
 *  return everything as strings or undefined; this normalizer is the single
 *  source of truth for the field-by-field defaulting + validation. */
const parseRawContent = (
    raw: Record<string, unknown> | undefined,
): AIConfigSettings => {
    const r = raw ?? {};
    const tierNum = Number(r.tier);
    const timeoutSecNum = Number(r.mcp_timeout_seconds);
    const rlNum = Number(r.rate_limit_per_hour);
    const toolCapNum = Number(r.tool_calls_per_session_cap);
    const spendCapNum = Number(r.daily_spend_cap_usd);
    return {
        enabled:
            r.enabled === '1' ||
            r.enabled === 'true' ||
            r.enabled === true ||
            r.enabled === 1,
        // Build 300 — a templates-only build forces this true regardless
        // of what the stored value says. This is the single chokepoint
        // for both sources: KV Store rows AND conf-file stanzas are
        // normalized here, so an admin cannot re-enable the LLM path by
        // any storage route (stale KV row carried over from a full-LLM
        // build, hand-edited local/ai_assistant_settings.conf, direct
        // REST write to the collection). `false || x` in a regular build.
        templates_only_mode:
            TEMPLATES_ONLY ||
            (r.templates_only_mode === undefined
                ? DEFAULT_AI_CONFIG.templates_only_mode
                : r.templates_only_mode === '1' ||
                  r.templates_only_mode === 'true' ||
                  r.templates_only_mode === true ||
                  r.templates_only_mode === 1),
        provider: isProvider(r.provider) ? r.provider : DEFAULT_AI_CONFIG.provider,
        default_model:
            typeof r.default_model === 'string' && r.default_model.length > 0
                ? r.default_model
                : DEFAULT_AI_CONFIG.default_model,
        tier: isTier(tierNum) ? tierNum : DEFAULT_AI_CONFIG.tier,
        mcp_required:
            r.mcp_required === '1' ||
            r.mcp_required === 'true' ||
            r.mcp_required === true ||
            r.mcp_required === 1,
        mcp_server_url:
            typeof r.mcp_server_url === 'string' ? r.mcp_server_url : '',
        mcp_timeout_seconds:
            Number.isFinite(timeoutSecNum) && timeoutSecNum >= 5 && timeoutSecNum <= 600
                ? Math.floor(timeoutSecNum)
                : DEFAULT_AI_CONFIG.mcp_timeout_seconds,
        rate_limit_per_hour:
            Number.isFinite(rlNum) && rlNum >= 0 && rlNum <= 10000
                ? Math.floor(rlNum)
                : DEFAULT_AI_CONFIG.rate_limit_per_hour,
        tool_calls_per_session_cap:
            Number.isFinite(toolCapNum) && toolCapNum >= 0 && toolCapNum <= 100000
                ? Math.floor(toolCapNum)
                : DEFAULT_AI_CONFIG.tool_calls_per_session_cap,
        daily_spend_cap_usd:
            Number.isFinite(spendCapNum) && spendCapNum >= 0 && spendCapNum <= 1000000
                ? spendCapNum
                : DEFAULT_AI_CONFIG.daily_spend_cap_usd,
        // Booleans default to the safe / default-secure value when the
        // key is missing from the source (fresh install) or unparseable.
        // For tier2_pii_redaction the safe default is true (redact);
        // for tier2_redact_hostnames the default is false.
        tier2_pii_redaction:
            r.tier2_pii_redaction === undefined
                ? DEFAULT_AI_CONFIG.tier2_pii_redaction
                : r.tier2_pii_redaction === '1' ||
                  r.tier2_pii_redaction === 'true' ||
                  r.tier2_pii_redaction === true ||
                  r.tier2_pii_redaction === 1,
        tier2_redact_hostnames:
            r.tier2_redact_hostnames === undefined
                ? DEFAULT_AI_CONFIG.tier2_redact_hostnames
                : r.tier2_redact_hostnames === '1' ||
                  r.tier2_redact_hostnames === 'true' ||
                  r.tier2_redact_hostnames === true ||
                  r.tier2_redact_hostnames === 1,
        audit_index_name:
            typeof r.audit_index_name === 'string' && r.audit_index_name.length > 0
                ? r.audit_index_name
                : DEFAULT_AI_CONFIG.audit_index_name,
        audit_forwarder_enabled:
            r.audit_forwarder_enabled === undefined
                ? DEFAULT_AI_CONFIG.audit_forwarder_enabled
                : r.audit_forwarder_enabled === '1' ||
                  r.audit_forwarder_enabled === 'true' ||
                  r.audit_forwarder_enabled === true ||
                  r.audit_forwarder_enabled === 1,
        audit_forwarder_url:
            typeof r.audit_forwarder_url === 'string'
                ? r.audit_forwarder_url
                : DEFAULT_AI_CONFIG.audit_forwarder_url,
        audit_forwarder_index:
            typeof r.audit_forwarder_index === 'string'
                ? r.audit_forwarder_index
                : DEFAULT_AI_CONFIG.audit_forwarder_index,
        audit_forwarder_source:
            typeof r.audit_forwarder_source === 'string' && r.audit_forwarder_source.length > 0
                ? r.audit_forwarder_source
                : DEFAULT_AI_CONFIG.audit_forwarder_source,
        power_user_roles:
            typeof r.power_user_roles === 'string'
                ? r.power_user_roles
                : DEFAULT_AI_CONFIG.power_user_roles,
        // Default ON when the key is absent (pre-275 KV rows / conf
        // stanzas) — matches the shipped default and Q1 resolution.
        model_discovery_enabled:
            r.model_discovery_enabled === undefined
                ? DEFAULT_AI_CONFIG.model_discovery_enabled
                : r.model_discovery_enabled === '1' ||
                  r.model_discovery_enabled === 'true' ||
                  r.model_discovery_enabled === true ||
                  r.model_discovery_enabled === 1,
    };
};

const readCsrfToken = (): string => {
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
    return m ? decodeURIComponent(m[1]) : '';
};

const buildSharedHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
});

const buildKvMutatingHeaders = (): Record<string, string> => ({
    ...buildSharedHeaders(),
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

let cache: AIConfigSettings | null = null;
let inflight: Promise<AIConfigSettings> | null = null;

/** Force a re-read on next access. Call after a successful write. */
export const clearAIConfigCache = (): void => {
    cache = null;
    inflight = null;
};

/** Internal: read the KV Store row. Returns parsed settings on hit, null
 *  on absence (404), undefined on any other error (caller falls back to
 *  the conf-file read). The three-state return distinguishes "absent"
 *  (migration should run) from "broken" (migration would over-write the
 *  customer's existing data if it later resurrects). */
const readKvStoreRow = async (): Promise<AIConfigSettings | null | undefined> => {
    try {
        const resp = await fetch(`${KV_ROW_URL}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (resp.status === 404) return null;
        if (!resp.ok) return undefined;
        const record = (await resp.json()) as Record<string, unknown>;
        return parseRawContent(record);
    } catch {
        return undefined;
    }
};

/** Internal: read the conf-file stanza. Returns parsed settings on hit
 *  (which may itself be the shipped baseline if no local/ override exists),
 *  undefined on REST failure or missing stanza. */
const readConfFileStanza = async (): Promise<AIConfigSettings | undefined> => {
    try {
        const resp = await fetch(`${CONF_STANZA_URL}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (!resp.ok) return undefined;
        const data = await resp.json();
        const content = data?.entry?.[0]?.content as
            | Record<string, unknown>
            | undefined;
        if (!content) return undefined;
        return parseRawContent(content);
    } catch {
        return undefined;
    }
};

/** Read the AI Assistant settings. Resolution order:
 *    1. KV Store row `defaults` (primary; admin saves land here)
 *    2. Conf-file stanza `[defaults]` (fresh install OR pre-migration)
 *    3. `DEFAULT_AI_CONFIG` (transient failure of both sources)
 *
 *  Always resolves — never rejects. Callers always get a usable config so
 *  the app can render. */
export const readAIConfig = async (): Promise<AIConfigSettings> => {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
        const fromKv = await readKvStoreRow();
        if (fromKv) {
            cache = fromKv;
            return cache;
        }
        const fromConf = await readConfFileStanza();
        if (fromConf) {
            cache = fromConf;
            return cache;
        }
        cache = { ...DEFAULT_AI_CONFIG };
        return cache;
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
};

/** Convert the strongly-typed config into the wire-format record stored
 *  in KV Store. Booleans become 0/1 numbers (KV Store coerces boolean
 *  values inconsistently — number 0/1 is the safest representation). */
const settingsToKvRecord = (cfg: AIConfigSettings): Record<string, unknown> => ({
    _key: SETTINGS_KEY,
    enabled: cfg.enabled ? 1 : 0,
    templates_only_mode: cfg.templates_only_mode ? 1 : 0,
    provider: cfg.provider,
    default_model: cfg.default_model,
    tier: cfg.tier,
    mcp_required: cfg.mcp_required ? 1 : 0,
    mcp_server_url: cfg.mcp_server_url,
    mcp_timeout_seconds: cfg.mcp_timeout_seconds,
    rate_limit_per_hour: cfg.rate_limit_per_hour,
    tool_calls_per_session_cap: cfg.tool_calls_per_session_cap,
    daily_spend_cap_usd: cfg.daily_spend_cap_usd,
    tier2_pii_redaction: cfg.tier2_pii_redaction ? 1 : 0,
    tier2_redact_hostnames: cfg.tier2_redact_hostnames ? 1 : 0,
    audit_index_name: cfg.audit_index_name,
    audit_forwarder_enabled: cfg.audit_forwarder_enabled ? 1 : 0,
    audit_forwarder_url: cfg.audit_forwarder_url,
    audit_forwarder_index: cfg.audit_forwarder_index,
    audit_forwarder_source: cfg.audit_forwarder_source,
    power_user_roles: cfg.power_user_roles,
    model_discovery_enabled: cfg.model_discovery_enabled ? 1 : 0,
    updated_at: new Date().toISOString(),
});

/** Internal: write a complete settings record to KV Store. Two-step
 *  upsert: POST to /<key> first (treated as create-or-overwrite); on 404
 *  (record doesn't yet exist) fall back to a collection-level POST that
 *  creates a new record at the supplied `_key`. Mirrors the
 *  `topology/persistence.ts` `saveLayoutNamed` pattern.
 *
 *  Note: KV Store POST to /<key> REPLACES the entire row (it is not a
 *  partial PATCH). We always write the full settings record to avoid
 *  nulling other fields. The `writeAIConfig` public API reads-then-
 *  writes to preserve partial-update semantics for the caller. */
const writeKvStoreRow = async (cfg: AIConfigSettings): Promise<void> => {
    const record = settingsToKvRecord(cfg);
    const body = JSON.stringify(record);
    let resp = await fetch(KV_ROW_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildKvMutatingHeaders(),
        body,
    });
    if (resp.status === 404) {
        resp = await fetch(KV_BASE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: buildKvMutatingHeaders(),
            body,
        });
    }
    if (!resp.ok) {
        throw new Error(`KV Store write failed: HTTP ${resp.status}`);
    }
};

/** Write a partial settings update. Reads the current settings, merges
 *  the partial on top, writes the full result back. Matches the prior
 *  conf-file API's partial-update semantics — keys absent from the
 *  partial keep their prior values.
 *
 *  Cache invalidation: after a successful write, `clearAIConfigCache()`
 *  is called so the next `readAIConfig` re-reads from KV Store. */
export const writeAIConfig = async (
    partial: Partial<AIConfigSettings>,
): Promise<void> => {
    if (Object.keys(partial).length === 0) {
        throw new Error('writeAIConfig called with empty partial');
    }
    // Read current (KV Store, conf-file, or default) and merge.
    const current = await readAIConfig();
    const merged: AIConfigSettings = { ...current, ...partial };
    await writeKvStoreRow(merged);
    clearAIConfigCache();
};

/** One-shot migration helper called from AIAssistantProvider on mount.
 *  Idempotent: if a KV Store row already exists, no-op. If absent, reads
 *  the conf-file stanza and copies it into KV Store. Best-effort; any
 *  failure is swallowed so the UI isn't blocked.
 *
 *  Why this is the right semantics: customers upgrading from a build
 *  that wrote settings to `local/ai_assistant_settings.conf` would
 *  otherwise see their customizations vanish after the upgrade (the
 *  KV Store row is empty on first load, so reads fall through to the
 *  default/ baseline). This helper preserves their state.
 *
 *  Concurrency: idempotent across multiple browser tabs opening the
 *  Settings page simultaneously — the if-empty-then-write pattern is
 *  naturally race-safe under KV Store upsert semantics. */
export const migrateConfFileSettingsToKvStore = async (): Promise<void> => {
    try {
        const existing = await readKvStoreRow();
        if (existing) return; // already migrated
        const fromConf = await readConfFileStanza();
        if (!fromConf) return; // nothing to migrate
        // Only migrate if the conf-file represents a NON-DEFAULT state —
        // otherwise we'd write the baseline into KV Store on every fresh
        // install, which is harmless but wasteful. Most fields match the
        // default on a fresh install; if any field differs, write.
        const isDefault =
            fromConf.enabled === DEFAULT_AI_CONFIG.enabled &&
            fromConf.templates_only_mode === DEFAULT_AI_CONFIG.templates_only_mode &&
            fromConf.provider === DEFAULT_AI_CONFIG.provider &&
            fromConf.default_model === DEFAULT_AI_CONFIG.default_model &&
            fromConf.tier === DEFAULT_AI_CONFIG.tier &&
            fromConf.mcp_required === DEFAULT_AI_CONFIG.mcp_required &&
            fromConf.mcp_server_url === DEFAULT_AI_CONFIG.mcp_server_url &&
            fromConf.mcp_timeout_seconds === DEFAULT_AI_CONFIG.mcp_timeout_seconds &&
            fromConf.audit_forwarder_enabled === DEFAULT_AI_CONFIG.audit_forwarder_enabled &&
            fromConf.audit_forwarder_url === DEFAULT_AI_CONFIG.audit_forwarder_url &&
            fromConf.power_user_roles === DEFAULT_AI_CONFIG.power_user_roles;
        if (isDefault) return;
        await writeKvStoreRow(fromConf);
        clearAIConfigCache();
    } catch {
        // Migration is best-effort — never block the UI.
    }
};
