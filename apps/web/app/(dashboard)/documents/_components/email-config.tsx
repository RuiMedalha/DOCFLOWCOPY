'use client';

/**
 * EmailConfig — per-tenant OAuth connection card for Gmail + Outlook.
 *
 * Reads `/email-inbound/status` and renders a Connect/Disconnect pair
 * per provider. The Connect button issues a request to the server-side
 * authorize endpoint and follows the returned `authUrl`; this is the
 * only call that requires a same-window navigation (the OAuth provider
 * owns the consent screen).
 */

import { useState } from 'react';
import { Mail, Link2, Unlink } from 'lucide-react';
import { authedFetch } from '../../../_lib/auth-refresh';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) || 'http://localhost:4000/api/v1';

interface ProviderStatus {
  connected: boolean;
  email?: string;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
}

interface StatusResponse {
  google: ProviderStatus;
  microsoft: ProviderStatus;
}

export function EmailConfig() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState<'google' | 'microsoft' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const res = await authedFetch(`${API_BASE}/email-inbound/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: StatusResponse };
      if (body.data) setStatus(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
    }
  }

  async function connect(provider: 'google' | 'microsoft') {
    setBusy(provider);
    setError(null);
    try {
      const res = await authedFetch(`${API_BASE}/email-inbound/oauth/${provider}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { authUrl: string } };
      if (body.data?.authUrl) {
        window.location.href = body.data.authUrl;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
      setBusy(null);
    }
  }

  async function disconnect(provider: 'google' | 'microsoft') {
    setBusy(provider);
    setError(null);
    try {
      const res = await authedFetch(`${API_BASE}/email-inbound/oauth/${provider}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="card p-4 space-y-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          Caixas de correio OAuth
        </p>
        <button
          type="button"
          className="btn-secondary text-xs px-2 py-1.5"
          onClick={() => refresh()}
          aria-label="Atualizar estado"
        >
          ↻
        </button>
      </div>
      {error && (
        <p className="text-xs" style={{ color: 'var(--danger-fg)' }}>
          {error}
        </p>
      )}
      <ProviderRow
        label="Microsoft Graph (Outlook / Exchange)"
        Icon={Mail}
        status={status?.microsoft}
        busy={busy === 'microsoft'}
        isManaged={true}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <ProviderRow
        label="Gmail"
        Icon={Mail}
        status={status?.google}
        busy={busy === 'google'}
        disabledReason="Desativado: política de canal único ativa em Microsoft Graph"
        onConnect={() => connect('google')}
        onDisconnect={() => disconnect('google')}
      />
    </div>
  );
}

function ProviderRow({
  label,
  Icon,
  status,
  busy,
  isManaged,
  disabledReason,
  onConnect,
  onDisconnect,
}: {
  label: string;
  Icon: typeof Mail;
  status?: ProviderStatus;
  busy: boolean;
  isManaged?: boolean;
  disabledReason?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = !!status?.connected;
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: connected ? 'rgba(56,189,248,0.10)' : 'var(--hover)',
          border: '1px solid var(--border)',
        }}
      >
        <Icon
          size={14}
          style={{ color: connected ? 'var(--accent)' : 'var(--text-subtle)' }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: 'var(--text)' }}>
          {label}
        </p>
        <p className="text-xs truncate" style={{ color: 'var(--text-subtle)' }}>
          {connected
            ? `Ligado${status?.email ? ` · ${status.email}` : ''}${
                status?.lastSyncAt
                  ? ` · última sync ${new Date(status.lastSyncAt).toLocaleString('pt-PT')}`
                  : ''
              }`
            : disabledReason || 'Desligado'}
        </p>
      </div>
      {isManaged ? (
        <span className="badge-emerald text-xs px-2.5 py-1 font-medium">
          Graph App-Only
        </span>
      ) : connected ? (
        <button
          type="button"
          className="btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
          onClick={onDisconnect}
          disabled={busy}
        >
          <Unlink size={12} /> Desligar
        </button>
      ) : disabledReason ? (
        <span className="badge-amber text-xs px-2.5 py-1 font-medium">
          Inativo
        </span>
      ) : (
        <button
          type="button"
          className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
          onClick={onConnect}
          disabled={busy}
        >
          <Link2 size={12} /> Ligar
        </button>
      )}
    </div>
  );
}

export default EmailConfig;
