import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { SplunkThemeProvider } from '@splunk/themes';
import {
    ColorTokens,
    ThemeMode,
    applyBodyModeClass,
    injectThemeVarStylesheet,
    readInitialThemeMode,
    resolveTokens,
    writeStoredThemeMode,
} from '../styles/magneticTokens';

/**
 * ThemeModeProvider — light/dark mode context for the Cisco Magnetic
 * re-theme (plan: cisco_magnetic_theme_plan_v0.1_20260705.md, Phase 0).
 *
 * Responsibilities:
 *  1. Own the current ThemeMode (initial: hash override → stored per-user
 *     choice → dark; see magneticTokens.readInitialThemeMode).
 *  2. Mount <GlobalThemeVars> — the `--lsv-*` CSS custom properties on
 *     <body> (dark values as the default block, light values under
 *     body.lsv-mode-light). Body-level so PORTALED components inherit.
 *  3. Keep the body mode classes in sync + persist explicit user choices.
 *  4. Expose `tokens` — the RESOLVED literal-hex set for Surface-2
 *     consumers (SVG attributes, colorMath.darken, chart seriesColors,
 *     @xyflow markers/minimap). Components re-render on mode flip because
 *     the context value changes.
 *
 * The variables are ALSO declared on the bare `body` selector with dark
 * values so anything painting before the mode class lands (or outside the
 * class scope) resolves to the dark palette — matching the pre-mount class
 * applied by pages/home/index.tsx.
 */

interface ThemeModeContextValue {
    mode: ThemeMode;
    setMode: (mode: ThemeMode) => void;
    /** Resolved literal-hex tokens for the CURRENT mode (Surface 2). */
    tokens: ColorTokens;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
    mode: 'dark',
    setMode: () => undefined,
    tokens: resolveTokens('dark'),
});

export const ThemeModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [mode, setModeState] = useState<ThemeMode>(() => readInitialThemeMode());

    /* Safety net: pages/home/index.tsx injects the --lsv-* stylesheet
     * synchronously BEFORE mount (flash-free first paint). This idempotent
     * call covers any entry point that bypasses index.tsx. */
    useEffect(() => {
        injectThemeVarStylesheet();
    }, []);

    /* Keep the body classes in sync with React state. index.tsx applies
     * the initial class pre-mount; this effect owns every change after. */
    useEffect(() => {
        applyBodyModeClass(mode);
    }, [mode]);

    const setMode = useCallback((next: ThemeMode): void => {
        setModeState(next);
        // Explicit user choice always persists (the hash override only
        // influences the INITIAL mode, never what gets stored).
        writeStoredThemeMode(next);
    }, []);

    const value = useMemo<ThemeModeContextValue>(
        () => ({ mode, setMode, tokens: resolveTokens(mode) }),
        [mode, setMode],
    );

    return (
        <ThemeModeContext.Provider value={value}>
            {children}
        </ThemeModeContext.Provider>
    );
};

export const useThemeMode = (): ThemeModeContextValue => useContext(ThemeModeContext);

/**
 * SplunkThemeScope — nested @splunk/themes provider that re-themes the
 * @splunk/react-ui + @splunk/visualizations subtree to match our mode
 * (prisma light ⟷ prisma dark). The @splunk/react-page `layout()` theme
 * set at bootstrap still governs Splunk Web chrome OUTSIDE the app tree;
 * index.tsx passes the stored mode there so the chrome matches on the
 * next full page load.
 */
export const SplunkThemeScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { mode } = useThemeMode();
    return (
        <SplunkThemeProvider family="prisma" colorScheme={mode} density="compact">
            {children}
        </SplunkThemeProvider>
    );
};
