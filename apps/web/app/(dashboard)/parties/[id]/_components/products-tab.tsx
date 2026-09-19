'use client';

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { usePartyProducts } from '../../_components/use-parties';

const eur = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(n);

/** Fase 4 — produtos comprados a este fornecedor (linhas agregadas). */
export function ProductsTab({ partyId }: { partyId: string }) {
  const { data, isLoading } = usePartyProducts(partyId);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Produtos comprados</h2>
        <p className="text-xs text-muted">
          Linhas de todas as faturas ligadas a este fornecedor, agrupadas por código de artigo (ou descrição).
          {data ? ` ${data.documents} documento(s).` : ''}
        </p>
      </div>
      {isLoading && (
        <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <Loader2 size={12} className="animate-spin" /> A carregar…
        </p>
      )}
      {!isLoading && (data?.items.length ?? 0) === 0 && (
        <div className="card p-5 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          Sem linhas de artigos extraídas para este fornecedor.
        </div>
      )}
      {(data?.items.length ?? 0) > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="text-left p-3">Artigo</th>
                <th className="text-right p-3">Compras</th>
                <th className="text-right p-3">Qtd. total</th>
                <th className="text-right p-3">Último preço un.</th>
                <th className="text-right p-3">Total gasto</th>
                <th className="text-right p-3">Última compra</th>
              </tr>
            </thead>
            <tbody>
              {data!.items.map((p) => (
                <tr key={p.key} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="p-3">
                    <div className="font-medium">{p.description || p.code}</div>
                    {p.code && <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{p.code}</div>}
                  </td>
                  <td className="p-3 text-right tabular-nums">{p.timesBought}</td>
                  <td className="p-3 text-right tabular-nums">{p.totalQuantity}</td>
                  <td className="p-3 text-right tabular-nums">{eur(p.lastUnitPrice)}</td>
                  <td className="p-3 text-right tabular-nums font-medium">{eur(p.totalSpent)}</td>
                  <td className="p-3 text-right">
                    {p.lastDocumentId ? (
                      <Link href={`/documents/${p.lastDocumentId}`} className="underline">
                        {p.lastDate ?? 'ver'}
                      </Link>
                    ) : (
                      p.lastDate ?? '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
