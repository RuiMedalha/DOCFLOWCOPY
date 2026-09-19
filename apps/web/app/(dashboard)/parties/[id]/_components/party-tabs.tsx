'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  FileText,
  History,
  Landmark,
  Package,
  User,
  Users,
  Wallet,
} from 'lucide-react';

export type PartyTabId =
  | 'identity'
  | 'contacts'
  | 'documents'
  | 'payments'
  | 'iban'
  | 'products'
  | 'timeline';

interface TabSpec {
  id: PartyTabId;
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

const TABS: TabSpec[] = [
  { id: 'identity', label: 'Identidade', icon: User },
  { id: 'contacts', label: 'Contactos', icon: Users },
  { id: 'documents', label: 'Documentos', icon: FileText },
  { id: 'payments', label: 'Pagamentos', icon: Wallet },
  { id: 'iban', label: 'IBAN', icon: Landmark },
  { id: 'products', label: 'Produtos', icon: Package },
  { id: 'timeline', label: 'Histórico', icon: History },
];

interface PartyTabsProps {
  partyId: string;
  active: PartyTabId;
  counts?: Partial<Record<PartyTabId, number>>;
}

/**
 * PartyTabs — horizontal tab nav with optional count badges per tab.
 *
 * Renders a `<button>` per tab with the active tab marked. Clicking a
 * tab calls `router.replace(/parties/[id]?tab=...)` so the URL stays
 * in sync (deep-linkable, browser back button works) without polluting
 * history with one entry per click.
 */
export function PartyTabs({ partyId, active, counts }: PartyTabsProps) {
  const router = useRouter();
  const sp = useSearchParams();

  const onSelect = (id: PartyTabId) => {
    const next = new URLSearchParams(sp?.toString() ?? '');
    next.set('tab', id);
    router.replace(`/parties/${partyId}?${next.toString()}`);
  };

  return (
    <nav
      role="tablist"
      aria-label="Secções da entidade"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === active;
        const count = counts?.[t.id];
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onSelect(t.id)}
            className={
              'inline-flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 -mb-px transition-colors ' +
              (isActive
                ? 'border-sky-500 text-sky-700 font-medium'
                : 'border-transparent text-muted hover:text-default')
            }
          >
            <Icon size={13} aria-hidden />
            <span>{t.label}</span>
            {typeof count === 'number' && count > 0 && (
              <span
                className={
                  'ml-0.5 inline-flex items-center justify-center text-[10px] min-w-[18px] h-[18px] px-1 rounded-full ' +
                  (isActive ? 'bg-sky-100 text-sky-700' : 'bg-muted/20 text-muted')
                }
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Resolve the active tab from the URL `?tab=` query (default: identity). */
export function usePartyTabFromUrl(): PartyTabId {
  const sp = useSearchParams();
  const tab = sp?.get('tab') ?? 'identity';
  const valid: PartyTabId[] = [
    'identity',
    'contacts',
    'documents',
    'payments',
    'iban',
    'products',
    'timeline',
  ];
  return (valid as string[]).includes(tab) ? (tab as PartyTabId) : 'identity';
}
