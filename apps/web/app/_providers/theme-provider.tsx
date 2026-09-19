'use client';

/**
 * DocFlow — Theme provider (next-themes)
 *
 * The design system has TWO parallel token layers:
 *   - base system (`--bg`, `--accent`, `--text`, ...): keys off `data-theme`
 *     and powers the existing dashboard chrome.
 *   - Editorial / Contábil skin (`--ed-canvas`, `--ed-ink`, `--ed-accent-gold`,
 *     ...): keys off `data-skin` and is the new Blueprint Edition cream +
 *     navy + gold identity (see globals.css `[data-skin='editorial']`).
 *
 * We intentionally drive next-themes with `attribute="data-skin"` and
 * `defaultTheme="editorial"` so the Blueprint Edition is the default
 * visual identity across the whole app. The legacy `[data-theme='dark']`
 * tokens still act as fallback if the provider has not hydrated yet
 * (e.g. SSR before mount), but the post-hydrate state is always
 * `[data-skin='editorial']`.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-skin"
      defaultTheme="editorial"
      themes={['editorial', 'dark']}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
