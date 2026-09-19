'use client';

/**
 * NotificationBell — polling indicator + dropdown.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useNotifications } from '@/_lib/use-dashboard-queries';

export function NotificationBell() {
  const { data: notifs = [] } = useNotifications();
  const [open, setOpen] = useState(false);
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

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="btn-ghost p-2 relative"
        title="Notificações"
        aria-label="Notificações"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {notifs.length > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 min-w-[14px] h-[14px] rounded-full text-[9px] font-bold flex items-center justify-center px-1"
            style={{
              background: 'var(--danger)',
              color: '#fff',
              boxShadow: '0 0 0 2px var(--bg-card-solid)',
            }}
          >
            {notifs.length > 9 ? '9+' : notifs.length}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full mt-2 right-0 w-80 glass-card overflow-hidden animate-pop z-50"
          style={{ background: 'var(--bg-card-solid)' }}
        >
          <div
            className="px-4 py-3 text-xs font-semibold border-b flex items-center justify-between"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            <span>Notificações</span>
            <span
              className="badge-neutral"
              style={{ background: 'var(--hover)', color: 'var(--text-muted)' }}
            >
              {notifs.length}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifs.length === 0 ? (
              <div
                className="p-6 text-xs text-center"
                style={{ color: 'var(--text-subtle)' }}
              >
                Sem alertas no momento.
              </div>
            ) : (
              notifs.map((n) => (
                <Link
                  key={n.id}
                  href={n.href ?? '/dashboard'}
                  onClick={() => setOpen(false)}
                  className="block px-4 py-3 border-b last:border-0 transition-colors hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div
                    className="text-xs font-medium"
                    style={{
                      color:
                        n.severity === 'danger'
                          ? 'var(--danger)'
                          : n.severity === 'warning'
                            ? 'var(--warning)'
                            : 'var(--text)',
                    }}
                  >
                    {n.title}
                  </div>
                  {n.body && (
                    <div
                      className="text-[11px] mt-0.5 leading-snug"
                      style={{ color: 'var(--text-subtle)' }}
                    >
                      {n.body}
                    </div>
                  )}
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}