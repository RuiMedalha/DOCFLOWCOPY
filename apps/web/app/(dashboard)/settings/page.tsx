'use client';

import { useState } from 'react';
import { Link2, User2, Building2, Cog, Cpu } from 'lucide-react';
import { PageHeader } from '../_components/page-header';
import { IntegrationsPanel } from './_components/integrations-panel';
import { ProfilePanel } from './_components/profile-panel';
import { AiPanel } from './_components/ai-panel';

type Tab = 'integrations' | 'ai' | 'profile' | 'tenant';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('integrations');
  return (
    <>
      <PageHeader title="Definições" subtitle="Integrações, modelos de IA, perfil e configuração do tenant." />
      <div className="flex items-center gap-1 mb-5 overflow-x-auto">
        <TabBtn id="integrations" current={tab} setTab={setTab} icon={<Link2 size={14} />}>Integrações</TabBtn>
        <TabBtn id="ai" current={tab} setTab={setTab} icon={<Cpu size={14} />}>Modelos de IA</TabBtn>
        <TabBtn id="profile" current={tab} setTab={setTab} icon={<User2 size={14} />}>Perfil</TabBtn>
        <TabBtn id="tenant" current={tab} setTab={setTab} icon={<Building2 size={14} />}>Tenant</TabBtn>
      </div>
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'ai' && <AiPanel />}
      {tab === 'profile' && <ProfilePanel />}
      {tab === 'tenant' && <TenantPanel />}
    </>
  );
}

function TabBtn({ id, current, setTab, icon, children }: { id: Tab; current: Tab; setTab: (t: Tab) => void; icon: React.ReactNode; children: React.ReactNode }) {
  const active = id === current;
  return (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-md transition-colors ${active ? 'bg-sky-500/10 text-sky-500 font-semibold' : ''}`}
      style={active ? undefined : { color: 'var(--text-muted)' }}
    >
      {icon}
      {children}
    </button>
  );
}

function TenantPanel() {
  return (
    <div className="card p-6 max-w-2xl space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-2"><Cog size={14} /> Definições do tenant</h3>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Configurações de fuso horário, idioma, branding e normas contabilísticas PT (PGC, VAT rates).
        Estas opções regem todos os módulos do DocFlow.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Idioma</label>
          <select className="select mt-1 w-full" disabled>
            <option>Português (Portugal)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Fuso horário</label>
          <select className="select mt-1 w-full" disabled>
            <option>Europe/Lisbon (UTC+0/+1)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Moeda</label>
          <select className="select mt-1 w-full" disabled>
            <option>EUR (€)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Norma contabilística</label>
          <select className="select mt-1 w-full" disabled>
            <option>PGC (Plano Geral de Contabilidade PT)</option>
          </select>
        </div>
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-subtle)' }}>
        Edição bloqueada na vista — contacte o suporte para alterar definições de tenant.
      </p>
    </div>
  );
}