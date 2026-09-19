'use client';

/**
 * UserMenu — avatar + dropdown with profile / settings / logout.
 *
 * Logout now uses the shared Dialog primitive for a proper confirmation
 * instead of window.confirm().
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { User as UserIcon, Settings, LogOut, ChevronDown, LogOut as LogOutIcon } from 'lucide-react';
import { useAuthStore } from '@/_lib/auth-store';
import { useUser } from '@/_lib/use-dashboard-queries';
import { Dialog } from '@/_components/ui/dialog';
import { Button } from '@/_components/ui/button';

export function UserMenu() {
  const router = useRouter();
  const user = useUser();
  const clear = useAuthStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const initials = (user?.name ?? user?.email ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  function handleLogout() {
    clear();
    setConfirmLogout(false);
    setOpen(false);
    router.push('/login');
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-xl p-1 transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] outline-none"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu do utilizador"
      >
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold text-white transition-transform hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, var(--accent-2), var(--accent-3))',
            boxShadow: '0 4px 12px -2px rgba(129, 140, 248, 0.40)',
          }}
        >
          {initials || '?'}
        </span>
        <span className="hidden lg:flex flex-col items-start leading-tight">
          <span
            className="text-sm font-medium truncate max-w-[160px]"
            style={{ color: 'var(--text)' }}
          >
            {user?.name ?? user?.email ?? 'Utilizador'}
          </span>
          <span className="text-[11px] truncate" style={{ color: 'var(--text-subtle)' }}>
            {user?.role ?? 'Admin'}
          </span>
        </span>
        <ChevronDown
          size={14}
          style={{ color: 'var(--text-subtle)' }}
          aria-hidden="true"
          className={['transition-transform duration-200', open ? 'rotate-180' : ''].join(' ')}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full mt-2 right-0 w-60 card-solid shadow-xl z-50 overflow-hidden animate-pop py-1.5"
          style={{
            background: 'var(--bg-card-solid)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div
            className="px-3 py-2.5 border-b mb-1"
            style={{ borderColor: 'var(--border)' }}
          >
            <div
              className="text-sm font-medium truncate"
              style={{ color: 'var(--text)' }}
            >
              {user?.name ?? user?.email ?? 'Utilizador'}
            </div>
            <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-subtle)' }}>
              {user?.email}
            </div>
          </div>

          <MenuItem
            icon={<UserIcon size={15} />}
            label="Perfil"
            onClick={() => {
              setOpen(false);
              router.push('/settings/profile');
            }}
          />
          <MenuItem
            icon={<Settings size={15} />}
            label="Definições"
            onClick={() => {
              setOpen(false);
              router.push('/settings');
            }}
          />
          <div className="my-1 mx-2 border-t" style={{ borderColor: 'var(--border)' }} />
          <MenuItem
            icon={<LogOut size={15} />}
            label="Terminar sessão"
            danger
            onClick={() => {
              setOpen(false);
              setConfirmLogout(true);
            }}
          />
        </div>
      )}

      <Dialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        size="sm"
        title="Terminar sessão?"
        description="A sua sessão será encerrada e terá de iniciar sessão novamente."
      >
        <div className="flex items-center justify-end gap-2 mt-2">
          <Button variant="ghost" onClick={() => setConfirmLogout(false)}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={handleLogout}>
            <LogOutIcon size={16} />
            <span>Terminar sessão</span>
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] outline-none"
      style={{ color: danger ? 'var(--danger)' : 'var(--text-muted)' }}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}