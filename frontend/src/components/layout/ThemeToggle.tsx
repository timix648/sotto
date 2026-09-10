'use client';

import { useTheme } from '@/hooks/useTheme';

/** Day / night. Renders a stable frame on the server and fills the glyph in
 *  once mounted, so the button never flickers between icons on hydration. */
export function ThemeToggle() {
  const { theme, toggle, ready } = useTheme();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light' : 'Dark'}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line
                 text-muted hover:text-txt hover:border-lineBright focusable transition-colors"
    >
      <span className={ready ? 'opacity-100' : 'opacity-0'}>
        {dark ? <SunIcon /> : <MoonIcon />}
      </span>
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
