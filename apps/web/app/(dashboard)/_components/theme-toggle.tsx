'use client';

/**
 * ThemeToggle — cycles between the Editorial / Contábil skin (default)
 * and the legacy dark chrome.
 *
 * The provider now keys off `data-skin`, so the only meaningful values
 * are `'editorial'` (Blueprint Edition — cream + navy + gold) and
 * `'dark'` (legacy chrome — kept as a fallback for users who want the
 * old look). We expose the same sun/moon affordance: Sun = editorial,
 * Moon = dark.
 */

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Alternar skin"
        className={`btn-ghost p-2 ${className}`}
        disabled
      >
        <Sun size={16} />
      </button>
    );
  }

  const isEditorial = resolvedTheme === 'editorial';
  return (
    <button
      type="button"
      onClick={() => setTheme(isEditorial ? 'dark' : 'editorial')}
      className={`btn-ghost p-2 ${className}`}
      aria-label={isEditorial ? 'Mudar para tema escuro' : 'Mudar para skin editorial'}
      title={isEditorial ? 'Tema escuro' : 'Skin editorial'}
    >
      <span key={isEditorial ? 'editorial' : 'dark'} className="inline-flex animate-pop">
        {isEditorial ? <Sun size={16} /> : <Moon size={16} />}
      </span>
    </button>
  );
}
