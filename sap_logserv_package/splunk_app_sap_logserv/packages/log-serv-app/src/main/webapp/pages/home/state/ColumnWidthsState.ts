/**
 * ColumnWidthsState.ts - the React side of the remembered table column widths (build 404).
 *
 * - sharedColumnWidthStore(): one ColumnWidthStore (utils/columnWidths.ts) for the signed-in user, shared by every
 *   table on the page, so a reset from a panel header reaches its table at once.
 * - DashboardIdContext: the dashboard a table is on (DashboardLayout provides it; null elsewhere, where widths are
 *   kept in memory only).
 * - TableWidthResetContext: how a table tells its FramedPanel that it has dragged widths, so the panel header can
 *   show a "Reset column widths" button for it (null outside a FramedPanel).
 *
 * Kept apart from components/ so DataTable and FramedPanel can both import it without importing each other.
 */
import { createContext } from 'react';
import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { ColumnWidthStore, browserStorage, storageKey } from '../utils/columnWidths';

let shared: ColumnWidthStore | null = null;

/** The signed-in user's column widths, read from this browser once and shared by every table. */
export const sharedColumnWidthStore = (): ColumnWidthStore => {
    if (shared === null) {
        const store = new ColumnWidthStore(browserStorage(), storageKey(splunkUsername));
        shared = store;
        // A width changed just before a reload, a tab close or a full-page link is written then, not lost with the
        // pending write (the store writes 300 ms after the last change). flush() writes nothing when nothing is pending.
        try {
            window.addEventListener('pagehide', () => {
                store.flush();
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    store.flush();
                }
            });
        } catch (err) {
            // no window (tests): the timer still writes
        }
    }
    return shared;
};

let lastWidthChangeMs = 0;
/** How long after a column width change the tables leave their page size alone (build 406). */
export const WIDTH_CHANGE_QUIET_MS = 400;
/** A table calls this on every column width change it makes: a drag step, an arrow key, a fit, a reset. */
export const noteColumnWidthChange = (): void => {
    lastWidthChangeMs = Date.now();
};
/**
 * True for WIDTH_CHANGE_QUIET_MS after any table's column width change. A narrower column wraps its rows, the panel
 * grows, and so does the panel beside it in the same grid row; a table that re-fitted its page size to that height
 * kept the extra rows after a Reset. So no table re-fits its page size to a height change a width change caused.
 */
export const columnWidthsJustChanged = (): boolean => Date.now() - lastWidthChangeMs < WIDTH_CHANGE_QUIET_MS;
/** The id of the dashboard being shown (state/dashboardRefreshPersistence.ts dashboardIdFromPath), or null. */
export const DashboardIdContext = createContext<string | null>(null);

/**
 * A table's way to show or hide its panel's reset button: set(token, reset) while it has dragged widths,
 * set(token, null) when it has none or unmounts. The token is the table's own stable object.
 */
export interface TableWidthReset {
    set: (token: object, reset: (() => void) | null) => void;
}

export const TableWidthResetContext = createContext<TableWidthReset | null>(null);
