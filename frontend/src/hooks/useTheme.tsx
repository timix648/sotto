'use client';

// Light / dark, as an explicit user choice.
//
// Precedence: a stored choice, then the operating system's preference, then
// light. The venue is designed light-first — the warm palette is the one we
// picked — but a trading screen at night is a real use, and a judge watching a
// video at 1am should not be flashbanged.
//
// The no-flash script in layout.tsx applies the same precedence BEFORE first
// paint, so the two must stay in agreement. If you change the order here,
// change it there too.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sotto.theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  /** False until mounted, so nothing renders a theme-dependent glyph on the server. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private mode — fall through to the system preference */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const initial = readInitial();
    setThemeState(initial);
    document.documentElement.setAttribute('data-theme', initial);
    setReady(true);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);

    // Arm the cross-fade for the duration of the swap only. Leaving it on
    // would transition every element on every unrelated repaint.
    const root = document.documentElement;
    root.classList.add('theme-switching');
    window.setTimeout(() => root.classList.remove('theme-switching'), 240);

    root.setAttribute('data-theme', t);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* the choice still applies for this session */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggle, ready }), [theme, setTheme, toggle, ready]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Runs before first paint so the page never renders in the wrong theme and
 * then snaps. Injected as a raw <script> in the document head.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = (stored === 'light' || stored === 'dark')
      ? stored
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;
