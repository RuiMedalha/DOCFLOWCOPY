'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Sparkles, X, Loader2 } from 'lucide-react';
import { Dialog } from '../../../../_components/ui';
import { http } from '@/_lib/http';

export interface ReExtractDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (options: { model?: string; provider?: string }) => void;
  loading?: boolean;
}

const POPULAR_MODELS = [
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (OpenRouter)', provider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OpenRouter)', provider: 'openrouter' },
  { id: 'anthropic/claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (Anthropic)', provider: 'anthropic' },
  { id: 'anthropic/claude-3-5-haiku', name: 'Claude 3.5 Haiku (Anthropic)', provider: 'anthropic' },
  { id: 'openai/gpt-4o', name: 'GPT-4o (OpenAI)', provider: 'openai' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (OpenAI)', provider: 'openai' },
  { id: 'minimax/MiniMax-M3', name: 'MiniMax M3 (MiniMax)', provider: 'minimax' },
  { id: 'faturista-pt-v1', name: 'Faturista PT v1 (Faturista)', provider: 'faturista' },
];

export function ReExtractDialog({
  open,
  onClose,
  onConfirm,
  loading = false,
}: ReExtractDialogProps) {
  const [provider, setProvider] = useState<string>('auto');
  const [selectedModel, setSelectedModel] = useState<string>('google/gemini-2.5-flash');
  const [customModel, setCustomModel] = useState<string>('');
  const [useCustom, setUseCustom] = useState<boolean>(false);

  const modelsQuery = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => http.get<any>('/ai/models'),
    staleTime: 60000,
    enabled: open,
  });

  const availableModels = useMemo(() => {
    const rawList: Array<{ id: string; name: string; provider: string }> = Array.isArray(modelsQuery.data)
      ? modelsQuery.data
      : Array.isArray(modelsQuery.data?.models)
        ? modelsQuery.data.models
        : [];
    if (rawList.length === 0) return POPULAR_MODELS;
    return rawList;
  }, [modelsQuery.data]);

  const filteredModels = useMemo(() => {
    if (provider === 'auto') return availableModels;
    const subset = availableModels.filter(
      (m) => m.provider.toLowerCase() === provider.toLowerCase(),
    );
    return subset.length > 0 ? subset : availableModels;
  }, [availableModels, provider]);

  useEffect(() => {
    if (filteredModels.length > 0 && !filteredModels.some((m) => m.id === selectedModel)) {
      setSelectedModel(filteredModels[0].id);
    }
  }, [filteredModels, selectedModel]);

  const handleConfirm = () => {
    const finalModel = useCustom ? customModel.trim() || undefined : selectedModel || undefined;
    const finalProvider = provider === 'auto' ? undefined : provider;
    onConfirm({ model: finalModel, provider: finalProvider });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Re-extrair Documento com Modelo Específico"
      size="md"
    >
      <div className="space-y-4 pt-2">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Força o reprocessamento integral a partir dos bytes originais no MinIO (rotação, OCR, QR-AT, IA e propostas contabilísticas), preservando as correções manuais do operador.
        </p>

        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted block mb-1">
            Fornecedor de IA
          </label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              // auto-select a matching model preset if available
              const match = POPULAR_MODELS.find((m) => m.provider === e.target.value);
              if (match) setSelectedModel(match.id);
            }}
            className="input w-full text-xs font-sans h-9 min-h-0 py-1.5 px-2.5"
          >
            <option value="auto">Automático (Seguir Routing do Tenant)</option>
            <option value="openrouter">OpenRouter (Multi-Model Gateway)</option>
            <option value="gemini">Google Gemini (Direto)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT-4o)</option>
            <option value="minimax">MiniMax</option>
            <option value="faturista">Faturista PT</option>
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted">
              Modelo de Extração
            </label>
            <button
              type="button"
              onClick={() => setUseCustom(!useCustom)}
              className="text-[11px] text-sky-500 hover:underline"
            >
              {useCustom ? 'Escolher da lista' : 'Inserir ID personalizado'}
            </button>
          </div>

          {useCustom ? (
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="ex: anthropic/claude-3-7-sonnet"
              className="input w-full text-xs font-mono h-9 min-h-0 py-1.5 px-2.5"
            />
          ) : (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="input w-full text-xs font-mono h-9 min-h-0 py-1.5 px-2.5"
            >
              {filteredModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
          <strong>Nota de Auditoria:</strong> O documento será atualizado com os novos campos extraídos e a telemetria (custo, tokens, latência e modelo) ficará registada nos metadados.
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-subtle">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded-md border border-subtle hover:bg-surface/80 text-muted"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="btn-primary px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5 font-medium"
          >
            {loading ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Sparkles size={13} />
            )}
            Re-extrair com este Modelo
          </button>
        </div>
      </div>
    </Dialog>
  );
}
