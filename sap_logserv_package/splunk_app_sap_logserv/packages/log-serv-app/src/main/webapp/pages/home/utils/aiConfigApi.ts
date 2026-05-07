/**
 * aiConfigApi — thin wrapper around Splunk's `configs/conf-<name>` REST
 * endpoint for reading and writing the admin-managed AI Assistant
 * defaults (provider, model, tier, enabled, mcp_required, mcp_server_url).
 *
 * Storage:
 *   `default/ai_assistant_settings.conf` ships the safe defaults
 *   (`enabled = false`, `provider = mock`, etc.). Admin writes from the
 *   Settings page land in `local/ai_assistant_settings.conf` and override
 *   per Splunk's normal default → local merge.
 *
 * Auth model:
 *   - Splunk Web session cookie via `credentials: 'same-origin'`
 *   - `X-Requested-With: XMLHttpRequest` header (always)
 *   - `X-Splunk-Form-Key: <csrf>` header on every mutating request
 *     (POST). Splunk Web rejects mutating requests without this token,
 *     even if the session cookie is valid.
 *   - Read: any user with `list_settings` (default for the `user` role
 *     in stock Splunk). The conf inherits the app's default.meta
 *     `read : [ * ]` permission, so non-admin users can fetch the
 *     active provider / tier on app load.
 *   - Write: admin only — the `configs/conf-*` endpoint requires the
 *     `admin_all_objects` capability for arbitrary conf files (admin
 *     role has it; user role does not).
 *
 * Cache: `readAIConfig()` results are memoized in-process to avoid one
 * REST round-trip per render. Call `clearAIConfigCache()` after a
 * successful write to force a re-read on the next access.
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const CONF_NAME = 'ai_assistant_settings';
const STANZA = 'defaults';
const NS_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/configs/conf-${CONF_NAME}`;
const STANZA_URL = `${NS_BASE}/${encodeURIComponent(STANZA)}`;

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
    provider: ProviderName;
    default_model: string;
    tier: PrivacyTier;
    mcp_required: boolean;
    mcp_server_url: string;
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
     *  posts. Default `_ai_assistant_audit` matches the LogServ Index
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
}

/** Safe in-process fallback used when the conf can't be read (e.g.,
 *  fresh install before any save, or transient REST failure). Mirrors
 *  the `default/ai_assistant_settings.conf` shipped values. */
export const DEFAULT_AI_CONFIG: AIConfigSettings = {
    enabled: false,
    provider: 'mock',
    default_model: 'mock-fast',
    tier: 1,
    mcp_required: true,
    mcp_server_url: '',
    rate_limit_per_hour: 30,
    tool_calls_per_session_cap: 100,
    daily_spend_cap_usd: 50.0,
    tier2_pii_redaction: true,
    tier2_redact_hostnames: false,
    audit_index_name: '_ai_assistant_audit',
    audit_forwarder_enabled: false,
    audit_forwarder_url: '',
    audit_forwarder_index: '',
    audit_forwarder_source: 'logserv_ai_assistant_remote',
    power_user_roles: '',
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

/** Splunk's conf REST returns all stanza keys as strings. Coerce to the
 *  schema shape defensively — bad values fall back to the shipped default. */
const parseRawContent = (
    raw: Record<string, unknown> | undefined,
): AIConfigSettings => {
    const r = raw ?? {};
    const tierNum = Number(r.tier);
    const rlNum = Number(r.rate_limit_per_hour);
    const toolCapNum = Number(r.tool_calls_per_session_cap);
    const spendCapNum = Number(r.daily_spend_cap_usd);
    return {
        enabled: r.enabled === '1' || r.enabled === 'true' || r.enabled === true,
        provider: isProvider(r.provider) ? r.provider : DEFAULT_AI_CONFIG.provider,
        default_model:
            typeof r.default_model === 'string' && r.default_model.length > 0
                ? r.default_model
                : DEFAULT_AI_CONFIG.default_model,
        tier: isTier(tierNum) ? tierNum : DEFAULT_AI_CONFIG.tier,
        mcp_required:
            r.mcp_required === '1' ||
            r.mcp_required === 'true' ||
            r.mcp_required === true,
        mcp_server_url:
            typeof r.mcp_server_url === 'string' ? r.mcp_server_url : '',
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
        // key is missing from the conf (fresh install) or unparseable.
        // For tier2_pii_redaction the safe default is true (redact);
        // for tier2_redact_hostnames the default is false.
        tier2_pii_redaction:
            r.tier2_pii_redaction === undefined
                ? DEFAULT_AI_CONFIG.tier2_pii_redaction
                : r.tier2_pii_redaction === '1' ||
                  r.tier2_pii_redaction === 'true' ||
                  r.tier2_pii_redaction === true,
        tier2_redact_hostnames:
            r.tier2_redact_hostnames === undefined
                ? DEFAULT_AI_CONFIG.tier2_redact_hostnames
                : r.tier2_redact_hostnames === '1' ||
                  r.tier2_redact_hostnames === 'true' ||
                  r.tier2_redact_hostnames === true,
        audit_index_name:
            typeof r.audit_index_name === 'string' && r.audit_index_name.length > 0
                ? r.audit_index_name
                : DEFAULT_AI_CONFIG.audit_index_name,
        audit_forwarder_enabled:
            r.audit_forwarder_enabled === undefined
                ? DEFAULT_AI_CONFIG.audit_forwarder_enabled
                : r.audit_forwarder_enabled === '1' ||
                  r.audit_forwarder_enabled === 'true' ||
                  r.audit_forwarder_enabled === true,
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

const buildMutatingHeaders = (): Record<string, string> => ({
    ...buildSharedHeaders(),
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Splunk-Form-Key': readCsrfToken(),
});

let cache: AIConfigSettings | null = null;
let inflight: Promise<AIConfigSettings> | null = null;

/** Force a re-read on next access. Call after a successful write. */
export const clearAIConfigCache = (): void => {
    cache = null;
    inflight = null;
};

/** Read the merged ai_assistant_settings stanza. Returns DEFAULT_AI_CONFIG
 *  for any failure mode (404, network error, parse error) so callers can
 *  always proceed. */
export const readAIConfig = async (): Promise<AIConfigSettings> => {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const resp = await fetch(`${STANZA_URL}?output_mode=json`, {
                credentials: 'same-origin',
                headers: buildSharedHeaders(),
            });
            if (!resp.ok) {
                cache = { ...DEFAULT_AI_CONFIG };
                return cache;
            }
            const data = await resp.json();
            const content = data?.entry?.[0]?.content as
                | Record<string, unknown>
                | undefined;
            cache = parseRawContent(content);
            return cache;
        } catch {
            cache = { ...DEFAULT_AI_CONFIG };
            return cache;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
};

/** Write a partial settings update to the [defaults] stanza. Splunk
 *  merges the body into the stanza — keys not in the partial keep their
 *  current values. Caller is responsible for the cache invalidation
 *  (which this function performs on success). */
export const writeAIConfig = async (
    partial: Partial<AIConfigSettings>,
): Promise<void> => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(partial)) {
        if (v === undefined) continue;
        let s: string;
        if (typeof v === 'boolean') s = v ? '1' : '0';
        else if (typeof v === 'number') s = String(v);
        else s = String(v);
        params.set(k, s);
    }
    if (params.toString().length === 0) {
        throw new Error('writeAIConfig called with empty partial');
    }
    const resp = await fetch(STANZA_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildMutatingHeaders(),
        body: params.toString(),
    });
    if (!resp.ok) {
        throw new Error(`Write failed: HTTP ${resp.status}`);
    }
    clearAIConfigCache();
};
