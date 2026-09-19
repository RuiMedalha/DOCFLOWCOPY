'use client';

import { Cpu, Clock, Coins, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';

export interface AiTelemetryData {
  provider?: string;
  model?: string;
  processingTimeMs?: number;
  tokens?: { prompt?: number; completion?: number; total?: number };
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostEur?: number;
  confidence?: number;
  fallbackUsed?: boolean;
  timestamp?: string;
}

export function AiTelemetryBadge({ ai }: { ai?: AiTelemetryData | null }) {
  if (!ai || (!ai.provider && !ai.model)) return null;

  const promptTokens = ai.tokens?.prompt ?? ai.tokensIn ?? 0;
  const completionTokens = ai.tokens?.completion ?? ai.tokensOut ?? 0;
  const cost = typeof ai.estimatedCostEur === 'number' ? ai.estimatedCostEur : 0;
  const timeMs = ai.processingTimeMs ?? 0;
  const conf = typeof ai.confidence === 'number' ? Math.round(ai.confidence * 100) : null;

  return (
    <div
      className="mb-4 p-3 rounded-lg border text-xs"
      style={{
        background: 'rgba(14, 165, 233, 0.04)',
        borderColor: 'rgba(14, 165, 233, 0.15)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-sky-600 dark:text-sky-400">
          <Cpu size={14} />
          <span>Extração por IA ({ai.provider ?? 'IA'}/{ai.model ?? 'modelo'})</span>
          {ai.fallbackUsed && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-500">
              <AlertTriangle size={10} /> Fallback
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-muted text-[11px] font-mono">
          {timeMs > 0 && (
            <span className="flex items-center gap-1" title="Tempo de resposta">
              <Clock size={11} /> {timeMs}ms
            </span>
          )}

          {(promptTokens > 0 || completionTokens > 0) && (
            <span title={`Tokens: ${promptTokens} entrada / ${completionTokens} saída`}>
              Tokens: {promptTokens} in / {completionTokens} out
            </span>
          )}

          {cost > 0 && (
            <span className="text-emerald-500 font-semibold" title="Custo estimado">
              <Coins size={11} className="inline mr-0.5" /> €{cost.toFixed(5)}
            </span>
          )}

          {conf != null && (
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                conf >= 85
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : conf >= 60
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'bg-rose-500/10 text-rose-500'
              }`}
              title="Confiança do modelo"
            >
              <ShieldCheck size={10} className="inline mr-0.5" /> {conf}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
