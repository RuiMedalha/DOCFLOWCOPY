'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../../_components/page-header';
import { AiPanel } from '../_components/ai-panel';

export default function AiSettingsPage() {
  return (
    <>
      <Link
        href="/settings"
        className="text-xs inline-flex items-center gap-1 mb-3"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft size={12} /> Voltar às Definições
      </Link>
      <PageHeader
        title="Modelos de IA & Gateway"
        subtitle="Configure fornecedores de IA, routing por tarefa, chaves de API e acompanhe a telemetria de consumo."
      />
      <AiPanel />
    </>
  );
}
