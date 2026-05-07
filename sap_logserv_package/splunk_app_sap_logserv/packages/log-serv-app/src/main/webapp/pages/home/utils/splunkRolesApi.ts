/**
 * splunkRolesApi — thin wrappers around Splunk's authentication endpoints
 * for the AI Assistant Power Mode role-gating feature (build 166 /
 * session 028).
 *
 * Two distinct endpoints:
 *
 *   `services/authentication/roles`         — list ALL roles defined on
 *                                              the Splunk instance (admin
 *                                              uses this to populate the
 *                                              Settings page Multiselect)
 *
 *   `services/authentication/current-context` — get the CURRENT user's
 *                                                username + roles array
 *                                                (every chat-panel mount
 *                                                uses this to determine
 *                                                Power Mode visibility)
 *
 * Both are read with the same Splunk Web session cookie + XHR header
 * pattern as `aiConfigApi.ts`. Failures resolve to safe defaults
 * (empty array of roles, empty username) so the UI renders without
 * blocking on transient REST errors.
 */

/* The role catalog lives under `services/authorization/roles` —
 * `services/authentication/roles` 404s. The `authentication`
 * namespace is for active sessions / users, while `authorization`
 * is for the role definitions themselves. Verified live on Splunk
 * 9.4.3 during build 166 / session 028 deploy. */
const ROLES_LIST_URL =
    '/en-US/splunkd/__raw/services/authorization/roles?output_mode=json&count=0';
const CURRENT_CONTEXT_URL =
    '/en-US/splunkd/__raw/services/authentication/current-context?output_mode=json';

const SHARED_HEADERS: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
};

/** List every role defined on this Splunk instance, sorted alphabetically.
 *  Used by the admin's Power Mode role-multiselect. Returns [] on failure. */
export const listSplunkRoles = async (): Promise<string[]> => {
    try {
        const resp = await fetch(ROLES_LIST_URL, {
            credentials: 'same-origin',
            headers: SHARED_HEADERS,
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        const entries: Array<{ name?: string }> = Array.isArray(data?.entry) ? data.entry : [];
        const roles = entries
            .map((e) => (typeof e?.name === 'string' ? e.name : ''))
            .filter((n) => n.length > 0)
            .sort((a, b) => a.localeCompare(b));
        return roles;
    } catch {
        return [];
    }
};

export interface CurrentUserContext {
    username: string;
    roles: string[];
}

/** Fetch the calling user's username and roles. Returns
 *  `{ username: '', roles: [] }` on failure — caller treats this as "no
 *  power-mode privileges" by definition. */
export const getCurrentUserContext = async (): Promise<CurrentUserContext> => {
    try {
        const resp = await fetch(CURRENT_CONTEXT_URL, {
            credentials: 'same-origin',
            headers: SHARED_HEADERS,
        });
        if (!resp.ok) return { username: '', roles: [] };
        const data = await resp.json();
        // Splunk's current-context endpoint returns a single entry whose
        // content has `username` (string) and `roles` (array of strings).
        const content = data?.entry?.[0]?.content as Record<string, unknown> | undefined;
        const username = typeof content?.username === 'string' ? content.username : '';
        const rawRoles = content?.roles;
        const roles = Array.isArray(rawRoles)
            ? rawRoles.filter((r): r is string => typeof r === 'string')
            : [];
        return { username, roles };
    } catch {
        return { username: '', roles: [] };
    }
};
