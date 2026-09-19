'use client';

import { PartyRecentDocuments } from './party-recent-documents';

interface DocumentsTabProps {
  partyId: string;
}

/**
 * DocumentsTab — thin wrapper over PartyRecentDocuments so the 6-tab
 * nav stays consistent. PartyRecentDocuments already does the
 * `GET /parties/:id/documents` request (existing route, no new API).
 *
 * FORNECEDOR-only per the existing component — when party.type !== FORNECEDOR,
 * the parent page renders nothing for this tab.
 */
export function DocumentsTab({ partyId }: DocumentsTabProps) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Documentos recentes</h2>
        <p className="text-xs text-muted">
          Últimas faturas associadas a esta entidade.
        </p>
      </div>
      <PartyRecentDocuments partyId={partyId} />
    </section>
  );
}
