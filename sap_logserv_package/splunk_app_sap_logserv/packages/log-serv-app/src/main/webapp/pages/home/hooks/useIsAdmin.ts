import { useEffect, useState } from 'react';

/**
 * useIsAdmin — fetches the current user's roles from Splunk's
 * `authentication/current-context` REST endpoint and reports whether
 * the user has an admin-tier role.
 *
 * Recognized admin-tier roles (any of these grants access):
 *   - `admin`        — Splunk Enterprise's universal admin
 *   - `sc_admin`     — Splunk Cloud's full administrator tier
 *   - `sc_subadmin`  — Splunk Cloud's customer-tier admin (often the
 *                      effective top admin on Splunk Cloud Victoria
 *                      deployments where `sc_admin` is reserved for
 *                      Splunk Cloud Ops staff and not exposed to
 *                      customers)
 *
 * Used to gate the AI Assistant settings page and any future admin-only
 * routes. Non-admin-tier users should not see the route's nav link, and
 * direct-URL access to admin routes should render a 403 fallback.
 *
 * The fetch uses Splunk's Web cookie via `credentials: 'same-origin'`,
 * matching the pattern in `components/ai/providers/credentials.ts`.
 *
 * Server-side ACL still applies: the metadata `[]` global stanza must
 * grant write to the role for any save action to actually succeed. See
 * `metadata/default.meta` for the canonical list. Adding a role here
 * without also granting it write in metadata.meta would give the user a
 * misleading "you're an admin" UI followed by a 403 on Save.
 */

const ADMIN_TIER_ROLES = ['admin', 'sc_admin', 'sc_subadmin'];

interface State {
    isAdmin: boolean;
    loading: boolean;
    username: string | null;
    roles: string[];
    error: Error | null;
}

const INITIAL: State = {
    isAdmin: false,
    loading: true,
    username: null,
    roles: [],
    error: null,
};

export const useIsAdmin = (): State => {
    const [state, setState] = useState<State>(INITIAL);

    useEffect(() => {
        let cancelled = false;
        const run = async (): Promise<void> => {
            try {
                const resp = await fetch(
                    '/en-US/splunkd/__raw/services/authentication/current-context?output_mode=json',
                    {
                        credentials: 'same-origin',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    },
                );
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}`);
                }
                const data = await resp.json();
                const entry = data?.entry?.[0]?.content as
                    | { username?: string; roles?: string[] }
                    | undefined;
                const roles = Array.isArray(entry?.roles) ? entry.roles : [];
                if (cancelled) return;
                setState({
                    isAdmin: roles.some((r) => ADMIN_TIER_ROLES.includes(r)),
                    loading: false,
                    username: entry?.username ?? null,
                    roles,
                    error: null,
                });
            } catch (err) {
                if (cancelled) return;
                setState({
                    isAdmin: false,
                    loading: false,
                    username: null,
                    roles: [],
                    error: err instanceof Error ? err : new Error(String(err)),
                });
            }
        };
        run();
        return () => {
            cancelled = true;
        };
    }, []);

    return state;
};
