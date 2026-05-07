import { useEffect, useState } from 'react';

/**
 * useIsAdmin — fetches the current user's roles from Splunk's
 * `authentication/current-context` REST endpoint and reports whether
 * the user has the `admin` role.
 *
 * Used to gate the AI Assistant settings page and any future admin-only
 * routes. Non-admins should not see the route's nav link, and direct-URL
 * access to admin routes should render a 403 fallback.
 *
 * The fetch uses Splunk's Web cookie via `credentials: 'same-origin'`,
 * matching the pattern in `components/ai/providers/credentials.ts`.
 */

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
                    isAdmin: roles.includes('admin'),
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
