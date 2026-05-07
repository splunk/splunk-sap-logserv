/**
 * passwordsApi — thin wrapper around Splunk's `storage/passwords` REST
 * endpoint for read / write / delete used by the admin Settings page.
 *
 * Auth model:
 *   - Splunk Web session cookie via `credentials: 'same-origin'`
 *   - `X-Requested-With: XMLHttpRequest` header (always)
 *   - `X-Splunk-Form-Key: <csrf>` header on every mutating request
 *     (POST / PUT / DELETE). Splunk's Web frontend rejects mutating
 *     requests without this CSRF token (HTTP 401), even if the session
 *     cookie is valid. The token lives in the `splunkweb_csrf_token_<port>`
 *     cookie set by Splunk Web at sign-in.
 *   - Admin role required on the server side: Splunk REST gates writes
 *     with the `edit_storage_passwords` capability and reading
 *     `clear_password` with `list_storage_passwords`.
 *
 * READ returns a SUMMARY ONLY — `length` + 7-char prefix — so the
 * settings UI never has the cleartext key in React state. The ground
 * truth lives in `passwords.conf` only.
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const NS_BASE = `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}/storage/passwords`;

const stanzaUrl = (realm: string, name: string): string =>
    `${NS_BASE}/${encodeURIComponent(`${realm}:${name}:`)}`;

/**
 * Read Splunk's CSRF token from the `splunkweb_csrf_token_<port>` cookie.
 * Splunk Web sets this on sign-in and requires it on every mutating
 * request as the `X-Splunk-Form-Key` header. The port suffix matches the
 * Splunk Web port the user is connected to (8000 by default).
 *
 * Returns an empty string if the cookie is absent — callers should still
 * send the header (Splunk will reject the request with 401 with a clear
 * error message rather than silently succeeding).
 */
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

const buildDeleteHeaders = (): Record<string, string> => ({
    ...buildSharedHeaders(),
    'X-Splunk-Form-Key': readCsrfToken(),
});

export interface CredentialSummary {
    /** True when an entry exists under this realm:name. */
    exists: boolean;
    /** Length of the stored cleartext (0 when absent). */
    length: number;
    /** First 7 characters of the stored cleartext (empty string when absent). */
    prefix: string;
}

const EMPTY_SUMMARY: CredentialSummary = { exists: false, length: 0, prefix: '' };

/** Read length + 7-char prefix of a credential without ever holding the
 *  cleartext in caller-visible state for longer than this function. */
export const readCredentialSummary = async (
    realm: string,
    name: string,
): Promise<CredentialSummary> => {
    const resp = await fetch(`${stanzaUrl(realm, name)}?output_mode=json`, {
        credentials: 'same-origin',
        headers: buildSharedHeaders(),
    });
    if (resp.status === 404) return EMPTY_SUMMARY;
    if (!resp.ok) {
        throw new Error(`Read failed: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const pw = (data?.entry?.[0]?.content?.clear_password as string | undefined) ?? '';
    return {
        exists: pw.length > 0,
        length: pw.length,
        prefix: pw.slice(0, 7),
    };
};

/**
 * Read the cleartext password for a realm:name pair. Use sparingly —
 * the cleartext should not be held in caller-visible state longer than
 * the brief moment needed to forward / sign / authenticate with it.
 *
 * Admin-only — `clear_password` access on `storage/passwords` requires
 * the `list_storage_passwords` capability (admin role only). For
 * non-admin callers Splunk returns the entry without the
 * `clear_password` field, so this resolves to empty string.
 *
 * Returns empty string when the credential does not exist or the
 * caller lacks admin rights.
 *
 * Build 98 — added so the audit forwarder can read its HEC token.
 */
export const readCredentialClear = async (
    realm: string,
    name: string,
): Promise<string> => {
    try {
        const resp = await fetch(`${stanzaUrl(realm, name)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (!resp.ok) return '';
        const data = await resp.json();
        const pw = (data?.entry?.[0]?.content?.clear_password as string | undefined) ?? '';
        return pw;
    } catch (_e) {
        return '';
    }
};

/** Create a new credential entry. Throws on conflict (use `writeCredential`
 *  for upsert behavior). */
const createCredential = async (
    realm: string,
    name: string,
    value: string,
): Promise<void> => {
    const params = new URLSearchParams();
    params.set('realm', realm);
    params.set('name', name);
    params.set('password', value);
    const resp = await fetch(NS_BASE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildMutatingHeaders(),
        body: params.toString(),
    });
    if (!resp.ok) {
        throw new Error(`Create failed: HTTP ${resp.status}`);
    }
};

/** Update an existing credential entry. Throws if the entry doesn't exist
 *  (use `writeCredential` for upsert behavior). */
const updateCredential = async (
    realm: string,
    name: string,
    value: string,
): Promise<void> => {
    const params = new URLSearchParams();
    params.set('password', value);
    const resp = await fetch(stanzaUrl(realm, name), {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildMutatingHeaders(),
        body: params.toString(),
    });
    if (!resp.ok) {
        throw new Error(`Update failed: HTTP ${resp.status}`);
    }
};

/** Upsert: try update first, fall back to create on 404. Mirrors the
 *  shell-script update_ai_credential.sh logic. */
export const writeCredential = async (
    realm: string,
    name: string,
    value: string,
): Promise<void> => {
    if (!value) {
        throw new Error('writeCredential called with empty value');
    }
    // Probe existence first so we get a clean error message when the
    // user lacks the capability (Splunk returns 403 on probe vs 404
    // on missing — different remediation).
    const summary = await readCredentialSummary(realm, name);
    if (summary.exists) {
        await updateCredential(realm, name, value);
    } else {
        await createCredential(realm, name, value);
    }
};

/** Remove a credential entry. No-op if the entry doesn't exist. */
export const deleteCredential = async (realm: string, name: string): Promise<void> => {
    const resp = await fetch(stanzaUrl(realm, name), {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: buildDeleteHeaders(),
    });
    if (resp.status === 404) return;
    if (!resp.ok) {
        throw new Error(`Delete failed: HTTP ${resp.status}`);
    }
};
