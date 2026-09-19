'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Cpu,
  RefreshCw,
  Zap,
  CheckCircle2,
  XCircle,
  Clock,
  Coins,
  ShieldCheck,
  TrendingUp,
  Sliders,
  Sparkles,
  Server,
} from 'lucide-react';
import { http } from '../../../_lib/http';
import { toastBus } from '../../../_components/ui';

interface AiSettings {
  defaultProvider: string;
  taskRouting: {
    triage: string;
    extraction: string;
    enrichment: string;
  };
  providers: Record<
    string,
    {
      configured: boolean;
      model: string;
    }
  >;
}

interface AiModel {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  recommendedFor?: string;
}

interface AiMetrics {
  totalExtractions: number;
  totalEstimatedCostEur: number;
  avgProcessingTimeMs: number;
  avgConfidence: number;
  fallbackCount: number;
  fallbackRate: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  recentExtractions: Array<{
    documentId: string;
    fileName: string;
    provider: string;
    model: string;
    processingTimeMs: number;
    estimatedCostEur: number;
    confidence: number;
    fallbackUsed: boolean;
    timestamp: string;
  }>;
}

export function AiPanel() {
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => http.get<AiSettings>('/ai/settings'),
  });

  const modelsQuery = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => http.get<any>('/ai/models'),
  });

  const metricsQuery = useQuery({
    queryKey: ['ai-metrics'],
    queryFn: () => http.get<AiMetrics>('/ai/metrics'),
    refetchInterval: 30000,
  });

  const [form, setForm] = useState<AiSettings['taskRouting'] | null>(null);
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null);

  const currentRouting = form ?? settingsQuery.data?.taskRouting ?? {
    triage: 'google/gemini-2.5-flash',
    extraction: 'google/gemini-2.5-flash',
    enrichment: 'google/gemini-2.5-flash',
  };

  const currentDefaultProvider =
    defaultProvider ?? settingsQuery.data?.defaultProvider ?? 'openrouter';

  const saveMutation = useMutation({
    mutationFn: (payload: {
      defaultProvider: string;
      taskRouting: AiSettings['taskRouting'];
    }) => http.put('/ai/settings', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
      toastBus.success('Definições de IA guardadas com sucesso.');
    },
    onError: (err: any) => {
      toastBus.error(err?.message || 'Falha ao guardar definições.');
    },
  });

  const refreshModelsMutation = useMutation({
    mutationFn: () => http.post<AiModel[]>('/ai/models/refresh', {}),
    onSuccess: (models) => {
      qc.invalidateQueries({ queryKey: ['ai-models'] });
      toastBus.success(`Catálogo atualizado: ${models.length} modelos disponíveis.`);
    },
    onError: (err: any) => {
      toastBus.error(err?.message || 'Falha ao atualizar modelos da OpenRouter.');
    },
  });

  const [testResults, setTestResults] = useState<
    Record<string, { loading: boolean; success?: boolean; message?: string; latencyMs?: number }>
  >({});

  const testProvider = async (provider: string, model?: string) => {
    setTestResults((prev) => ({ ...prev, [provider]: { loading: true } }));
    try {
      const res = await http.post<{ success: boolean; message: string; latencyMs: number }>(
        '/ai/test-connection',
        { provider, model },
      );
      setTestResults((prev) => ({
        ...prev,
        [provider]: {
          loading: false,
          success: res.success,
          message: res.message,
          latencyMs: res.latencyMs,
        },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [provider]: {
          loading: false,
          success: false,
          message: err?.message || 'Erro de ligação',
          latencyMs: 0,
        },
      }));
    }
  };

  const rawModels = modelsQuery.data as any;
  const models: AiModel[] = Array.isArray(rawModels)
    ? rawModels
    : Array.isArray(rawModels?.models)
    ? rawModels.models
    : Array.isArray(rawModels?.data?.models)
    ? rawModels.data.models
    : [];
  const metrics = metricsQuery.data;

  return (
    <div className="space-y-8 max-w-5xl">
      {/* ── SECÇÃO 1: MÉTRICAS E TELEMETRIA ───────────────────────────────── */}
      {metrics && metrics.totalExtractions > 0 && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp size={16} className="text-sky-500" />
              Telemetria & Métricas Acumuladas
            </h3>
            <span className="text-xs text-muted">Últimos 200 documentos</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg border bg-surface/50 border-subtle">
              <div className="text-[11px] text-muted flex items-center gap-1">
                <Cpu size={12} /> Total Extrações
              </div>
              <div className="text-xl font-bold font-mono mt-1">
                {metrics.totalExtractions}
              </div>
            </div>

            <div className="p-3 rounded-lg border bg-surface/50 border-subtle">
              <div className="text-[11px] text-muted flex items-center gap-1">
                <Coins size={12} /> Custo Estimado
              </div>
              <div className="text-xl font-bold font-mono mt-1 text-emerald-500">
                €{metrics.totalEstimatedCostEur.toFixed(4)}
              </div>
            </div>

            <div className="p-3 rounded-lg border bg-surface/50 border-subtle">
              <div className="text-[11px] text-muted flex items-center gap-1">
                <Clock size={12} /> Latência Média
              </div>
              <div className="text-xl font-bold font-mono mt-1">
                {metrics.avgProcessingTimeMs} ms
              </div>
            </div>

            <div className="p-3 rounded-lg border bg-surface/50 border-subtle">
              <div className="text-[11px] text-muted flex items-center gap-1">
                <ShieldCheck size={12} /> Confiança Média
              </div>
              <div className="text-xl font-bold font-mono mt-1 text-sky-500">
                {Math.round(metrics.avgConfidence * 100)}%
              </div>
            </div>
          </div>

          {/* Histórico recente */}
          {metrics.recentExtractions.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
                Extrações Recentes
              </div>
              <div className="border rounded-md border-subtle overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-muted/30 text-muted font-medium border-b border-subtle">
                    <tr>
                      <th className="p-2">Documento</th>
                      <th className="p-2">Fornecedor / Modelo</th>
                      <th className="p-2">Tempo</th>
                      <th className="p-2">Custo</th>
                      <th className="p-2">Confiança</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-subtle font-mono">
                    {metrics.recentExtractions.slice(0, 5).map((e) => (
                      <tr key={e.documentId} className="hover:bg-muted/10">
                        <td className="p-2 font-sans truncate max-w-[200px]" title={e.fileName}>
                          <a
                            href={`/documents/${e.documentId}`}
                            className="text-sky-500 hover:underline"
                          >
                            {e.fileName}
                          </a>
                        </td>
                        <td className="p-2 text-muted">
                          {e.provider} / {e.model}
                        </td>
                        <td className="p-2 text-muted">{e.processingTimeMs}ms</td>
                        <td className="p-2 text-emerald-500">
                          €{e.estimatedCostEur.toFixed(5)}
                        </td>
                        <td className="p-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              e.confidence >= 0.85
                                ? 'bg-emerald-500/10 text-emerald-500'
                                : e.confidence >= 0.6
                                ? 'bg-amber-500/10 text-amber-500'
                                : 'bg-rose-500/10 text-rose-500'
                            }`}
                          >
                            {Math.round(e.confidence * 100)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SECÇÃO 2: ROUTING DE TAREFAS ──────────────────────────────────── */}
      <div className="card p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sliders size={16} className="text-sky-500" />
              Routing de Tarefas & Gateway de Modelos
            </h3>
            <p className="text-xs text-muted mt-1">
              Atribua o modelo mais eficiente a cada etapa do processamento documental.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              saveMutation.mutate({
                defaultProvider: currentDefaultProvider,
                taskRouting: currentRouting,
              })
            }
            disabled={saveMutation.isPending}
            className="btn-primary text-xs px-3 py-2 flex items-center gap-1.5"
          >
            {saveMutation.isPending ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            Guardar Routing
          </button>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              1. Triagem & Validação
            </label>
            <p className="text-[11px] text-muted mb-2">
              Classificação fiscal rápida, deteção de tipo documental e orientação.
            </p>
            <select
              value={currentRouting.triage}
              onChange={(e) =>
                setForm({ ...currentRouting, triage: e.target.value })
              }
              className="input w-full text-xs font-mono h-9 min-h-0 py-1.5 px-2.5"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              2. Extração de Faturas
            </label>
            <p className="text-[11px] text-muted mb-2">
              Leitura multimodal profunda: NIF, linhas, descontos e taxas de IVA.
            </p>
            <select
              value={currentRouting.extraction}
              onChange={(e) =>
                setForm({ ...currentRouting, extraction: e.target.value })
              }
              className="input w-full text-xs font-mono h-9 min-h-0 py-1.5 px-2.5"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              3. Enriquecimento Contábil
            </label>
            <p className="text-[11px] text-muted mb-2">
              Classificação SNC/PGC, dedutibilidade de IVA e propostas de lançamento.
            </p>
            <select
              value={currentRouting.enrichment}
              onChange={(e) =>
                setForm({ ...currentRouting, enrichment: e.target.value })
              }
              className="input w-full text-xs font-mono h-9 min-h-0 py-1.5 px-2.5"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="pt-2 border-t border-subtle">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted block mb-1">
            Fornecedor Principal (Default Provider)
          </label>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'openrouter', label: 'OpenRouter (Multi-Model Gateway)' },
              { id: 'gemini', label: 'Google Gemini (Direto)' },
              { id: 'anthropic', label: 'Anthropic Claude' },
              { id: 'openai', label: 'OpenAI (GPT-4o)' },
              { id: 'minimax', label: 'MiniMax' },
              { id: 'faturista', label: 'Faturista PT' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setDefaultProvider(p.id)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-all ${
                  currentDefaultProvider === p.id
                    ? 'border-sky-500 bg-sky-500/10 text-sky-500 font-semibold'
                    : 'border-subtle hover:bg-surface/80 text-muted'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── SECÇÃO 3: TESTE DE CONEXÃO DOS FORNECEDORES ───────────────────── */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Server size={16} className="text-sky-500" />
          Conectividade com Fornecedores de IA
        </h3>
        <p className="text-xs text-muted">
          Teste a resposta das chaves de API configuradas no ambiente e meça a latência do gateway.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { id: 'openrouter', name: 'OpenRouter', model: 'google/gemini-2.5-flash' },
            { id: 'gemini', name: 'Google Gemini', model: 'gemini-2.5-flash' },
            { id: 'anthropic', name: 'Anthropic', model: 'claude-3-5-haiku-20241022' },
            { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini' },
            { id: 'minimax', name: 'MiniMax', model: 'MiniMax-M3' },
            { id: 'faturista', name: 'Faturista PT', model: 'faturista-pt-v1' },
          ].map((prov) => {
            const configured =
              settingsQuery.data?.providers?.[prov.id]?.configured ?? false;
            const res = testResults[prov.id];

            return (
              <div
                key={prov.id}
                className="p-3.5 rounded-lg border border-subtle bg-surface/30 flex flex-col justify-between space-y-3"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs">{prov.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        configured
                          ? 'bg-emerald-500/10 text-emerald-500'
                          : 'bg-muted/20 text-muted'
                      }`}
                    >
                      {configured ? 'Configurado' : 'Não detetado'}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-muted block mt-1">
                    {settingsQuery.data?.providers?.[prov.id]?.model || prov.model}
                  </span>
                </div>

                <div>
                  {res && !res.loading && (
                    <div
                      className={`text-[11px] flex items-center gap-1.5 mb-2 font-medium ${
                        res.success ? 'text-emerald-500' : 'text-rose-500'
                      }`}
                    >
                      {res.success ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                      <span className="truncate">
                        {res.message} {res.latencyMs ? `(${res.latencyMs}ms)` : ''}
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => testProvider(prov.id, prov.model)}
                    disabled={res?.loading}
                    className="w-full text-xs py-1.5 px-2 border rounded border-subtle hover:bg-surface/80 flex items-center justify-center gap-1.5"
                  >
                    {res?.loading ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Zap size={12} className="text-amber-500" />
                    )}
                    Testar Conexão
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── SECÇÃO 4: CATÁLOGO DE MODELOS ─────────────────────────────────── */}
      <div className="card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles size={16} className="text-sky-500" />
              Catálogo de Modelos Recomendados
            </h3>
            <p className="text-xs text-muted mt-1">
              Lista atualizada de modelos suportados para leitura multimodal e extração de faturas.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshModelsMutation.mutate()}
            disabled={refreshModelsMutation.isPending}
            className="text-xs py-1.5 px-3 border rounded border-subtle hover:bg-surface/80 flex items-center gap-1.5"
          >
            <RefreshCw
              size={13}
              className={refreshModelsMutation.isPending ? 'animate-spin' : ''}
            />
            Atualizar da OpenRouter
          </button>
        </div>

        <div className="border rounded-lg border-subtle overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-muted/30 text-muted font-medium border-b border-subtle">
              <tr>
                <th className="p-2.5">Modelo</th>
                <th className="p-2.5">Fornecedor</th>
                <th className="p-2.5">Contexto</th>
                <th className="p-2.5">Custo Entrada / Saída (1M)</th>
                <th className="p-2.5">Recomendação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle font-mono">
              {models.map((m) => (
                <tr key={m.id} className="hover:bg-muted/10">
                  <td className="p-2.5">
                    <div className="font-semibold font-sans">{m.name}</div>
                    <div className="text-[11px] text-muted">{m.id}</div>
                  </td>
                  <td className="p-2.5 font-sans capitalize">{m.provider}</td>
                  <td className="p-2.5 text-muted">
                    {m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : '—'}
                  </td>
                  <td className="p-2.5 text-muted">
                    {m.inputCostPer1M != null
                      ? `$${m.inputCostPer1M.toFixed(2)} / $${m.outputCostPer1M?.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="p-2.5 font-sans">
                    {m.recommendedFor ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-sky-500/10 text-sky-500 font-medium">
                        {m.recommendedFor}
                      </span>
                    ) : (
                      <span className="text-muted text-[11px]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
