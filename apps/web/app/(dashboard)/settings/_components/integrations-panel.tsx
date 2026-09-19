'use client';

/**
 * DocFlow â€” Settings Â· Integrations panel.
 *
 * Lists configured integrations and lets the ADMIN configure new ones,
 * test the connection, and trigger a manual sync.
 */

import { useState } from 'react';
import { Loader2, RefreshCw, Power, ExternalLink, KeyRound, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  useIntegrations,
  useConfigureIntegration,
  useSyncIntegration,
  useTestIntegration,
  useAuthorizeIntegration,
} from './use-settings';
import { PROVIDER_PRESETS, getProviderPreset, type ProviderSpec } from '../_lib/types';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) || 'http://localhost:4000/api/v1';

export function IntegrationsPanel() {
  const { data: rawIntegrations, isLoading } = useIntegrations();
  const integrations = (rawIntegrations ?? []).filter((i) => (i.provider as string) !== 'ai_settings');
  const [activeProvider, setActiveProvider] = useState<string | null>(null);

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-3">
        <h3 className="text-sm font-semibold">IntegraÃ§Ãµes configuradas</h3>
        {isLoading ? (
          <div className="card p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            <Loader2 size={14} className="inline animate-spin mr-2" /> A carregarâ€¦
          </div>
        ) : (integrations ?? []).length === 0 ? (
          <div className="card p-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Nenhuma integraÃ§Ã£o configurada.
          </div>
        ) : (
          <ul className="space-y-2">
            {integrations?.map((i) => {
              const preset = getProviderPreset(i.provider);
              return (
                <li key={i.id} className="card p-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{preset?.name ?? i.provider}</span>
                      {i.isActive ? (
                        <span className="badge text-[10px]" style={{ background: 'rgba(34,197,94,0.10)', color: '#10b981' }}>Ativa</span>
                      ) : (
                        <span className="badge text-[10px]">Inativa</span>
                      )}
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      {preset?.description ?? 'IntegraÃ§Ã£o personalizada'}
                    </div>
                    {i.lastSyncAt && (
                      <div className="text-[10px] mt-1" style={{ color: 'var(--text-subtle)' }}>
                        Ãšltima sync: {new Date(i.lastSyncAt).toLocaleString('pt-PT')} ({i.lastSyncStatus ?? 'â€”'})
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-secondary text-xs px-3 py-1.5"
                    onClick={() => setActiveProvider(i.provider)}
                  >
                    Configurar
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <h3 className="text-sm font-semibold pt-4">Adicionar nova integraÃ§Ã£o</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          {PROVIDER_PRESETS.map((p) => (
            <ProviderCard
              key={p.id}
              preset={p}
              isConfigured={!!integrations?.some((i) => i.provider === p.id)}
              onSelect={() => setActiveProvider(p.id)}
            />
          ))}
        </div>
      </div>

      <div className="lg:col-span-1">
        {activeProvider ? (
          <ProviderConfigForm
            providerId={activeProvider}
            onClose={() => setActiveProvider(null)}
          />
        ) : (
          <div className="card p-5 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Selecione uma integraÃ§Ã£o Ã  esquerda para configurar.
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ preset, isConfigured, onSelect }: { preset: ProviderSpec; isConfigured: boolean; onSelect: () => void }) {
  return (
    <div className="card p-4 flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{preset.name}</span>
          {isConfigured && <span className="badge text-[10px]" style={{ background: 'rgba(56,189,248,0.10)', color: '#0ea5e9' }}>configurada</span>}
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{preset.description}</p>
      </div>
      <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={onSelect}>
        {isConfigured ? 'Editar' : 'Configurar'}
      </button>
    </div>
  );
}

function ProviderConfigForm({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const preset = getProviderPreset(providerId);
  const test = useTestIntegration(providerId);
  const configure = useConfigureIntegration();
  const authorize = useAuthorizeIntegration();
  const sync = useSyncIntegration();

  const [form, setForm] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  if (!preset) {
    return (
      <div className="card p-5 text-center text-sm text-red-500">
        Provider desconhecido: {providerId}
      </div>
    );
  }

  const presetFields = preset.fields;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      const payload: Record<string, string> = {};
      for (const f of presetFields) {
        const v = form[f.key];
        if (v != null && v !== '') payload[f.key] = v;
      }
      await configure.mutateAsync({ provider: providerId, credentials: payload });
      setFeedback({ type: 'ok', msg: 'Credenciais guardadas.' });
      setForm({});
    } catch (err) {
      setFeedback({ type: 'err', msg: (err as Error).message });
    }
  }

  async function onTest() {
    setFeedback(null);
    try {
      const res = await authedFetchJson(`${API_BASE}/integrations/${providerId}/test`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setFeedback({ type: 'ok', msg: `LigaÃ§Ã£o OK. Credenciais lidas: ${Object.keys(json?.data?.credentials ?? {}).length}` });
    } catch (err) {
      setFeedback({ type: 'err', msg: (err as Error).message });
    }
  }

  async function onAuthorize() {
    setFeedback(null);
    try {
      const redirectUri = typeof window !== 'undefined' ? `${window.location.origin}/integrations/${providerId}/callback` : '';
      const res = await authedFetchJson(`${API_BASE}/integrations/${providerId}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const oauthUrl = (json?.data?.oauthUrl ?? json?.oauthUrl) as string | undefined;
      if (oauthUrl) {
        setOauthUrl(oauthUrl);
        window.open(oauthUrl, '_blank', 'noopener');
      } else {
        setFeedback({ type: 'ok', msg: 'Sem URL de autorizaÃ§Ã£o devolvida pelo servidor.' });
      }
    } catch (err) {
      setFeedback({ type: 'err', msg: (err as Error).message });
    }
  }

  async function onSync() {
    setFeedback(null);
    try {
      const res = await sync.mutateAsync({ provider: providerId });
      setFeedback({ type: 'ok', msg: `Sync concluÃ­do${res.synced != null ? ` (${res.synced} itens)` : ''}.` });
    } catch (err) {
      setFeedback({ type: 'err', msg: (err as Error).message });
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <KeyRound size={14} /> {preset.name}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{preset.description}</p>
        </div>
        <button type="button" className="text-xs" style={{ color: 'var(--text-muted)' }} onClick={onClose}>
          Fechar
        </button>
      </header>

      {test.data && (
        <div className="rounded-md p-2 text-xs space-y-1" style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border)' }}>
          <div className="font-medium flex items-center gap-1">
            {test.data.configured ? <CheckCircle2 size={12} className="text-emerald-500" /> : <AlertTriangle size={12} className="text-amber-500" />}
            {test.data.configured ? 'IntegraÃ§Ã£o configurada' : 'Sem credenciais guardadas'}
          </div>
          {test.data.credentials && (
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Campos: {Object.keys(test.data.credentials).join(', ') || 'â€”'}
            </div>
          )}
        </div>
      )}

      {preset.hasOAuth ? (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Esta integraÃ§Ã£o requer OAuth. Clique para abrir o consent screen.
          </p>
          <button
            type="button"
            className="btn-primary w-full text-xs inline-flex items-center justify-center gap-2"
            disabled={authorize.isPending}
            onClick={onAuthorize}
          >
            {authorize.isPending ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
            Iniciar OAuth
          </button>
          {oauthUrl && (
            <p className="text-[10px] break-all" style={{ color: 'var(--text-muted)' }}>
              <a href={oauthUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{oauthUrl}</a>
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={onSave} className="space-y-3">
          {presetFields.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {f.label} {f.required && '*'}
              </label>
              {f.type === 'select' ? (
                <select
                  className="select mt-1 w-full text-xs"
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  required={f.required}
                >
                  <option value="">â€”</option>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  className="input mt-1 w-full text-xs"
                  type={f.type === 'password' ? 'password' : 'text'}
                  required={f.required}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              )}
            </div>
          ))}

          <div className="flex items-center justify-end gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={onTest} disabled={test.isFetching}>
              {test.isFetching ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
              Testar
            </button>
            <button type="submit" className="btn-primary text-xs px-3 py-1.5" disabled={configure.isPending}>
              {configure.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Guardar
            </button>
          </div>
        </form>
      )}

      {preset.syncSupported && (
        <button
          type="button"
          className="btn-secondary w-full text-xs inline-flex items-center justify-center gap-2"
          onClick={onSync}
          disabled={sync.isPending}
        >
          {sync.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Sincronizar agora
        </button>
      )}

      {feedback && (
        <div
          className="rounded-md p-2 text-xs flex items-start gap-2"
          style={{
            background: feedback.type === 'ok' ? 'rgba(34,197,94,0.08)' : 'rgba(248,113,113,0.08)',
            border: `1px solid ${feedback.type === 'ok' ? 'rgba(34,197,94,0.30)' : 'rgba(248,113,113,0.30)'}`,
          }}
        >
          {feedback.type === 'ok' ? <CheckCircle2 size={14} className="text-emerald-500" /> : <AlertTriangle size={14} className="text-red-500" />}
          <span>{feedback.msg}</span>
        </div>
      )}
    </div>
  );
}

function getAuthToken(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useAuthStore } = require('../../../_lib/auth-store') as typeof import('../../../_lib/auth-store');
  return useAuthStore.getState().accessToken ?? '';
}

function authedFetchJson(input: string, init?: RequestInit): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authedFetch } = require('../../../_lib/auth-refresh') as typeof import('../../../_lib/auth-refresh');
  return authedFetch(input, init);
}
