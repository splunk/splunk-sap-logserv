/**
 * Credentials helper — reads provider secrets from Splunk's
 * `storage/passwords` REST endpoint (which is backed by `passwords.conf`).
 *
 * Convention used by Phase D providers:
 *   - **realm**:    `logserv_ai_assistant_<provider>`
 *                    (e.g., `logserv_ai_assistant_anthropic`)
 *   - **username**: the field within that realm
 *                    (e.g., `api_key`, `access_key_id`, `region`)
 *
 * An admin populates these via either the Splunk REST API
 * (`POST /services/storage/passwords` with `realm`/`name`/`password`),
 * the Splunk CLI, or the future Phase G admin UI.
 *
 * **Auth model**:
 *   - Uses the requesting user's Splunk Web cookie
 *   - Server returns `clear_password` only if the user has the
 *     `list_storage_passwords` capability (admin role does)
 *   - For Phase D smoke testing we assume admin; Phase G adds a
 *     server-side REST handler that exposes a "use the key" abstraction
 *     so non-admin users can use the AI Assistant without seeing the key
 *
 * Cache: results are memoized per (provider, field) to avoid one REST
 * round-trip per stream() call. Call `clearCredentialCache()` when the
 * admin updates a credential to force a re-read.
 */

const REALM_PREFIX = 'logserv_ai_assistant';
const APP_NAMESPACE = 'splunk_app_sap_logserv';

export interface ReadSecretOptions {
    /** Inject `fetch` for tests. */
    fetchImpl?: typeof fetch;
    /** Override Splunk app namespace (default: splunk_app_sap_logserv). */
    appName?: string;
    /** Skip cache (default: false; cache enabled). */
    skipCache?: boolean;
}

/** Single in-process cache shared across providers + sessions. */
const cache = new Map<string, string>();

const cacheKey = (providerName: string, fieldName: string): string =>
    `${providerName}::${fieldName}`;

/**
 * Force a re-read on next access. Call this when the admin has updated
 * a credential outside of this app (CLI, REST, etc.).
 */
export const clearCredentialCache = (): void => {
    cache.clear();
};

/**
 * Read a single secret value by (providerName, fieldName).
 *
 * Returns `null` if the credential isn't set. Throws `CredentialReadError`
 * for transport/auth failures (so providers can surface a useful message).
 *
 * Example:
 *   const apiKey = await readSecret('anthropic', 'api_key');
 *   const region = await readSecret('bedrock', 'region');
 */
export const readSecret = async (
    providerName: string,
    fieldName: string,
    options: ReadSecretOptions = {},
): Promise<string | null> => {
    const skipCache = options.skipCache === true;
    if (!skipCache) {
        const cached = cache.get(cacheKey(providerName, fieldName));
        if (cached !== undefined) return cached;
    }

    const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const appName = options.appName ?? APP_NAMESPACE;
    const realm = `${REALM_PREFIX}_${providerName}`;

    // Splunk's storage/passwords stanza key is `<realm>:<name>:` — colons
    // need URL-encoding for the path component.
    const stanzaKey = encodeURIComponent(`${realm}:${fieldName}:`);
    const url =
        `/en-US/splunkd/__raw/servicesNS/nobody/${appName}` +
        `/storage/passwords/${stanzaKey}?output_mode=json`;

    let response: Response;
    try {
        response = await fetchImpl(url, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
    } catch (err) {
        throw new CredentialReadError(
            `Network error reading ${realm}:${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (response.status === 404) {
        if (!skipCache) cache.set(cacheKey(providerName, fieldName), '');
        return null;
    }
    if (!response.ok) {
        throw new CredentialReadError(
            `HTTP ${response.status} reading ${realm}:${fieldName}` +
            (response.status === 403
                ? ' (current user lacks list_storage_passwords capability)'
                : ''),
        );
    }

    let json: PasswordListResponse;
    try {
        json = (await response.json()) as PasswordListResponse;
    } catch (err) {
        throw new CredentialReadError(
            `Malformed JSON reading ${realm}:${fieldName}`,
        );
    }

    const entry = (json.entry ?? [])[0];
    const value = entry?.content?.clear_password ?? '';
    if (!skipCache) cache.set(cacheKey(providerName, fieldName), value);
    return value || null;
};

/**
 * Read a required secret. Throws `CredentialMissingError` (a subclass of
 * `CredentialReadError`) if not set — providers use this when an absent
 * credential should fail config validation rather than try to call the
 * vendor with an empty key.
 */
export const requireSecret = async (
    providerName: string,
    fieldName: string,
    options: ReadSecretOptions = {},
): Promise<string> => {
    const value = await readSecret(providerName, fieldName, options);
    if (value === null) {
        throw new CredentialMissingError(
            `Required credential not set: ${REALM_PREFIX}_${providerName}:${fieldName}. ` +
            `Set via Splunk REST: POST /services/storage/passwords ` +
            `realm=${REALM_PREFIX}_${providerName} name=${fieldName} password=<value>`,
        );
    }
    return value;
};

interface PasswordListResponse {
    entry?: Array<{
        name: string;
        content?: {
            realm?: string;
            username?: string;
            clear_password?: string;
        };
    }>;
}

export class CredentialReadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CredentialReadError';
    }
}

export class CredentialMissingError extends CredentialReadError {
    constructor(message: string) {
        super(message);
        this.name = 'CredentialMissingError';
    }
}
