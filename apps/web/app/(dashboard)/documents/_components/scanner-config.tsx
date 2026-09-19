'use client';

/**
 * ScannerConfig — operator UI for the chokidar file watcher. Surfaces
 * watch path + start/stop controls so the admin can flip the watcher
 * without restarting the API.
 */

import { useState } from 'react';
import { Play, Square, FolderOpen } from 'lucide-react';
import { authedFetch } from '../../../_lib/auth-refresh';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) || 'http://localhost:4000/api/v1';

interface StatusResponse {
  state: 'running' | 'stopped';
  watchPath: string;
}

export function ScannerConfig() {
  const [state, setState] = useState<'running' | 'stopped' | 'unknown'>('unknown');
  const [watchPath, setWatchPath] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy refresh — the page invokes refresh() on mount via the parent's
  // refresh hook, but we expose a refresh button so the admin can re-read
  // status after a watcher crash.
  async function refresh() {
    setError(null);
    try {
      const res = await authedFetch(`${API_BASE}/scanner/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: StatusResponse };
      if (body.data) {
        setState(body.data.state);
        setWatchPath(body.data.watchPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
    }
  }

  async function call(endpoint: 'start' | 'stop') {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`${API_BASE}/scanner/${endpoint}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: StatusResponse };
      if (body.data) {
        setState(body.data.state);
        setWatchPath(body.data.watchPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="card p-4 flex items-center gap-4"
      style={{ borderColor: 'var(--border)' }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{
          background: state === 'running' ? 'rgba(56,189,248,0.10)' : 'var(--hover)',
          border: '1px solid var(--border)',
        }}
      >
        <FolderOpen
          size={18}
          style={{ color: state === 'running' ? 'var(--accent)' : 'var(--text-subtle)' }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          Scanner file watcher
        </p>
        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          {watchPath || '—'}
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-subtle)' }}>
          Estado:&nbsp;
          <span
            style={{
              color: state === 'running' ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: 600,
            }}
          >
            {state === 'running' ? 'a vigiar' : state === 'stopped' ? 'parado' : 'desconhecido'}
          </span>
          {error ? ` · ${error}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {state === 'running' ? (
          <button
            type="button"
            className="btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
            onClick={() => call('stop')}
            disabled={busy}
          >
            <Square size={12} /> Parar
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
            onClick={() => call('start')}
            disabled={busy}
          >
            <Play size={12} /> Iniciar
          </button>
        )}
        <button
          type="button"
          className="btn-secondary text-xs px-2 py-1.5"
          onClick={() => refresh()}
          disabled={busy}
          aria-label="Atualizar estado"
        >
          ↻
        </button>
      </div>
    </div>
  );
}

export default ScannerConfig;
