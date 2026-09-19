'use client';

import React, { useState } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Calculator,
  Receipt,
  FileCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

export interface CertaintyData {
  score?: number | null;
  level?: 'OFFICIAL_AT' | 'PERFECT_TRIANGULATION' | 'REVIEW_REQUIRED' | 'CRITICAL' | null;
  label?: string | null;
  needsReview?: boolean;
  triangulation?: {
    isValid: boolean;
    netAmount: number | null;
    taxAmount: number | null;
    total: number | null;
    expectedTotal: number | null;
    delta: number | null;
    reason: string;
    passedCheck?: string;
    warning?: string;
  };
  lineItemsValidation?: {
    isValid: boolean;
    totalLines: number;
    sumOfLines: number | null;
    discrepancies?: Array<{
      lineIndex: number;
      description: string;
      expectedSubtotal: number;
      actualSubtotal: number;
      delta: number;
    }>;
  };
  vatRatesValidation?: {
    isValid: boolean;
    ratesChecked: number[];
    invalidRates: number[];
  };
  tenantNifValidation?: {
    status: 'CONFIRMED' | 'MISSING_NIF' | 'MISMATCH_THIRD_PARTY' | 'NOT_CONFIGURED';
    hasTenantNif: boolean;
    isOfficialDocument: boolean;
    customerNif?: string | null;
    tenantNif?: string | null;
    label: string;
    warning?: string;
    passedCheck?: string;
  };
  passedChecks?: string[];
  warnings?: string[];
}

export function CertaintyBadge({
  certainty,
  certaintyScore,
}: {
  certainty?: CertaintyData | null;
  certaintyScore?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const score = certainty?.score ?? certaintyScore;
  if (score == null) return null;

  const level = certainty?.level ?? (score >= 99.5 ? 'OFFICIAL_AT' : score >= 97.0 ? 'PERFECT_TRIANGULATION' : 'REVIEW_REQUIRED');

  // Configuração visual do Badge
  let badgeClasses = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
  let icon = <AlertTriangle size={14} className="text-amber-500" />;
  let defaultLabel = `${score.toFixed(1)}% · Requer Revisão`;

  if (level === 'OFFICIAL_AT' || score >= 99.5) {
    badgeClasses = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
    icon = <ShieldCheck size={14} className="text-emerald-600 dark:text-emerald-400" />;
    defaultLabel = '99.9% · Validado Oficial AT';
  } else if (level === 'PERFECT_TRIANGULATION' || score >= 97.0) {
    badgeClasses = 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30';
    icon = <CheckCircle2 size={14} className="text-teal-600 dark:text-teal-400" />;
    defaultLabel = `${score.toFixed(1)}% · Triangulação Perfeita`;
  } else if (level === 'CRITICAL' || score < 70) {
    badgeClasses = 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
    icon = <AlertTriangle size={14} className="text-rose-500" />;
    defaultLabel = `${score.toFixed(1)}% · Inconsistência Crítica`;
  }

  const label = certainty?.label || defaultLabel;

  return (
    <div className="mb-4 rounded-lg border text-xs overflow-hidden transition-all duration-200" style={{ borderColor: 'var(--ed-rule)' }}>
      {/* Barra Principal */}
      <div
        className={`flex items-center justify-between px-3 py-2 cursor-pointer select-none transition-colors ${badgeClasses}`}
        onClick={() => setExpanded(!expanded)}
        title="Clique para ver os detalhes da conferência matemática e fiscal"
      >
        <div className="flex items-center gap-2 font-semibold">
          {icon}
          <span className="font-mono text-[13px]">{score.toFixed(1)}%</span>
          <span className="font-medium text-[12px] opacity-90">{label}</span>
        </div>

        <div className="flex items-center gap-2 text-[11px] opacity-80">
          <span className="hidden sm:inline">
            {certainty?.warnings && certainty.warnings.length > 0 ? (
              <span className="text-rose-500 font-medium">
                {certainty.warnings.length} {certainty.warnings.length === 1 ? 'discrepância' : 'discrepâncias'}
              </span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">100% conferido</span>
            )}
          </span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {/* Painel Expandido com Detalhes da Triangulação */}
      {expanded && (
        <div className="p-3 bg-muted/30 border-t space-y-2.5 text-[11px]" style={{ borderColor: 'var(--ed-rule)' }}>
          {/* Salvaguarda Fiscal NIF da Empresa (art. 36.º CIVA) */}
          {certainty?.tenantNifValidation && (
            <div
              className={`p-2.5 rounded-md border text-xs space-y-1 ${
                certainty.tenantNifValidation.isOfficialDocument
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                  : certainty.tenantNifValidation.status === 'MISMATCH_THIRD_PARTY'
                  ? 'bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-300'
                  : 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300'
              }`}
            >
              <div className="font-semibold flex items-center gap-1.5">
                {certainty.tenantNifValidation.isOfficialDocument ? (
                  <CheckCircle2 size={13} className="shrink-0 text-emerald-600" />
                ) : (
                  <AlertTriangle size={13} className="shrink-0" />
                )}
                <span>Salvaguarda Fiscal: {certainty.tenantNifValidation.label}</span>
              </div>
              {certainty.tenantNifValidation.warning && (
                <p className="text-[11px] leading-relaxed opacity-95">
                  {certainty.tenantNifValidation.warning}
                </p>
              )}
              {certainty.tenantNifValidation.passedCheck && (
                <p className="text-[11px] leading-relaxed opacity-95">
                  {certainty.tenantNifValidation.passedCheck}
                </p>
              )}
            </div>
          )}

          {/* Alertas de Discrepância */}
          {certainty?.warnings && certainty.warnings.length > 0 && (
            <div className="p-2.5 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-xs">
                <AlertTriangle size={13} />
                <span>Avisos de Validação (Requer Revisão):</span>
              </div>
              <ul className="list-disc pl-4 space-y-0.5">
                {certainty.warnings.map((warn, i) => (
                  <li key={i}>{warn}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Triangulação Líquido + IVA = Total */}
          {certainty?.triangulation && (
            <div className="flex items-start gap-2 text-foreground">
              <Calculator size={14} className="mt-0.5 text-sky-500 shrink-0" />
              <div>
                <span className="font-semibold">Triangulação Aritmética: </span>
                {certainty.triangulation.isValid ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    Líquido ({certainty.triangulation.netAmount?.toFixed(2)}€) + IVA ({certainty.triangulation.taxAmount?.toFixed(2)}€) == Total ({certainty.triangulation.total?.toFixed(2)}€)
                    {certainty.triangulation.delta != null && Math.abs(certainty.triangulation.delta) > 0 && (
                      <span className="text-muted text-[10px] ml-1">
                        (Δ {certainty.triangulation.delta > 0 ? '+' : ''}{certainty.triangulation.delta.toFixed(2)}€)
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-rose-600 dark:text-rose-400 font-medium">
                    {certainty.triangulation.warning || 'Discrepância na soma do líquido com o IVA'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Verificações Aprovadas */}
          {certainty?.passedChecks && certainty.passedChecks.length > 0 && (
            <div className="space-y-1 pt-1 border-t" style={{ borderColor: 'var(--ed-rule)' }}>
              <span className="font-semibold text-muted text-[10px] uppercase tracking-wider">Verificações de Certeza:</span>
              <ul className="space-y-1">
                {certainty.passedChecks.map((check, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={12} className="shrink-0" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
