'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, Plus, ShieldCheck, ShieldAlert, Repeat } from 'lucide-react';
import { useParties, useDeleteParty } from './use-parties';
import type { PartyFilters } from '../_lib/types';

const INITIAL: PartyFilters = { search: '', type: '', isActive: 'true', ibanOnly: false };

export function PartiesList() {
  const [filters, setFilters] = useState<PartyFilters>(INITIAL);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useParties(filters, page, 25);
  const del = useDeleteParty();
  const items = data?.items ?? [];
  const totalPages = data?.meta?.totalPages ?? 1;

  return (
    <div className="space-y-4">
      <div className="card p-4 grid sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2 relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Pesquisar nome, NIF, IBAN, email…"
            className="input pl-8 w-full"
            value={filters.search}
            onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }}
          />
        </div>
        <select className="select" value={filters.type} onChange={(e) => { setFilters({ ...filters, type: e.target.value as '' | 'FORNECEDOR' | 'CLIENTE' | 'AMBOS' }); setPage(1); }}>
          <option value="">Todos os tipos</option>
          <option value="FORNECEDOR">Fornecedor</option>
          <option value="CLIENTE">Cliente</option>
          <option value="AMBOS">Ambos</option>
        </select>
        <Link href="/parties/new" className="btn-primary text-xs px-3 py-2 inline-flex items-center justify-center gap-1">
          <Plus size={12} /> Nova entidade
        </Link>
      </div>

      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>{data?.meta.total ?? 0} entidade{(data?.meta.total ?? 0) !== 1 ? 's' : ''}</span>
        <Link href="/parties/blacklist" className="hover:underline">Lista negra de IBANs →</Link>
      </div>

      {isError ? (
        <div className="card p-6 text-sm text-red-500">Erro ao carregar entidades.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>NIF</th>
                <th>IBAN</th>
                <th className="text-center">Risco IBAN</th>
                <th>Cidade</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-12 text-xs" style={{ color: 'var(--text-muted)' }}>A carregar…</td></tr>
              )}
              {!isLoading && items.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-xs" style={{ color: 'var(--text-muted)' }}>Sem entidades.</td></tr>
              )}
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/parties/${p.id}`} className="text-sm font-medium hover:underline">
                      {p.name}
                    </Link>
                    {!p.isActive && <span className="ml-2 text-[10px] uppercase tracking-wide text-red-500">inativo</span>}
                    {p.isRecurringManualOverride && (
                      <span
                        className="ml-2 badge-amber text-[10px] inline-flex items-center"
                        title="Override ADMIN — isRecurring travado, auto-flip pausado"
                      >
                        <Repeat size={9} className="mr-0.5" aria-hidden="true" />
                        Override ADMIN
                      </span>
                    )}
                    {p.isRecurring && !p.isRecurringManualOverride && (
                      <span
                        className="ml-2 badge-emerald text-[10px] inline-flex items-center"
                        title="Fornecedor recorrente — ≥3 faturas associadas"
                      >
                        <Repeat size={9} className="mr-0.5" aria-hidden="true" />
                        Recorrente
                      </span>
                    )}
                    {p.partyCategory && (
                      <span
                        className="ml-2 text-[10px] inline-flex items-center px-2 py-0.5 rounded-full font-medium"
                        style={{
                          backgroundColor: p.partyCategory.color
                            ? `${p.partyCategory.color}20`
                            : 'rgba(148,163,184,0.15)',
                          color: p.partyCategory.color ?? 'var(--text-muted)',
                          border: `1px solid ${p.partyCategory.color ?? 'var(--border)'}`,
                        }}
                        title={`PartyCategory: ${p.partyCategory.name}`}
                      >
                        {p.partyCategory.name}
                      </span>
                    )}
                  </td>
                  <td><span className="badge text-[10px]">{p.type}</span></td>
                  <td className="font-mono text-xs">{p.nif ?? '—'}</td>
                  <td className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {p.iban ? `${p.iban.slice(0, 4)}…${p.iban.slice(-4)}` : '—'}
                  </td>
                  <td className="text-center">
                    {p.iban ? (
                      p.ibanFlagged ? (
                        <ShieldAlert size={14} className="inline text-red-500" />
                      ) : p.ibanVerified ? (
                        <ShieldCheck size={14} className="inline text-emerald-500" />
                      ) : (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>—</span>
                      )
                    ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td className="text-xs" style={{ color: 'var(--text-muted)' }}>{p.city ?? '—'}</td>
                  <td className="text-right">
                    <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => { if (confirm(`Eliminar ${p.name}?`)) del.mutate(p.id); }}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <span style={{ color: 'var(--text-muted)' }}>Página {page} de {totalPages}</span>
          <div className="flex gap-1">
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Seguinte</button>
          </div>
        </div>
      )}
    </div>
  );
}