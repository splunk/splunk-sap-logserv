import { createContext } from 'react';

/**
 * Identifies the global SID and Host filter selection (build 395). A context of
 * its own because `useSearch` needs it and the filter's provider uses `useSearch`.
 * Constant while the selection is unchanged, so nothing else moves on it.
 */
export const FilterKeyContext = createContext<string>('');
