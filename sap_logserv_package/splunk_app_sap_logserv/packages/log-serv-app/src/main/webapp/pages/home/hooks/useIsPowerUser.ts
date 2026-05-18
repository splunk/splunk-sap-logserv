import { useEffect, useState } from 'react';
import { getCurrentUserContext } from '../utils/splunkRolesApi';
import { parsePowerUserRoles } from '../state/AIAssistantConfig';

/**
 * useIsPowerUser — returns true when the calling user has at least one
 * role that intersects the admin's `power_user_roles` config setting.
 *
 * The membership check happens once on mount (or when `csv` changes) by
 * intersecting the user's roles array with the admin's allow-list.
 * Defaults to `false` until the async fetch completes — never shows the
 * Power Mode UI optimistically.
 *
 * Build 166 / session 028.
 *
 * @param csv  CSV-encoded role allow-list from
 *             `ai_assistant_settings.conf [defaults] power_user_roles`.
 *             Empty string means "no one is a power user".
 */
export const useIsPowerUser = (csv: string): boolean => {
    const [isPowerUser, setIsPowerUser] = useState<boolean>(false);

    useEffect(() => {
        const allowed = parsePowerUserRoles(csv);
        if (allowed.length === 0) {
            setIsPowerUser(false);
            return;
        }
        let cancelled = false;
        void (async () => {
            const ctx = await getCurrentUserContext();
            if (cancelled) return;
            const allowedSet = new Set(allowed);
            const granted = ctx.roles.some((r) => allowedSet.has(r));
            setIsPowerUser(granted);
        })();
        return () => { cancelled = true; };
    }, [csv]);

    return isPowerUser;
};
