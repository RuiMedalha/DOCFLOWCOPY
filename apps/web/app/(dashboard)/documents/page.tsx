'use client';

/**
 * DocFlow — Document Inbox page (Sprint F tabs).
 *
 * Sprint F segments the inbox into three channels:
 *   - PDF: drag-and-drop upload (existing) → origin=UPLOAD
 *   - Scanner: file-watcher ingest → origin=SCANNER
 *   - Email: IMAP / SendGrid / Gmail OAuth / Outlook OAuth →
 *     origin=EMAIL | GMAIL | OUTLOOK | INBOUND_WEBHOOK
 *
 * The tab swap just changes the `origin` filter sent to the backend;
 * `useDocumentsList` is reused so React Query keeps a cache per filter
 * shape and switching tabs feels instant.
 */

import { useState } from 'react';
import { RefreshCw, AlertCircle, Sparkles, Cloud, MessageSquare, ShoppingCart } from 'lucide-react';
import type { RowSelectionState } from '@tanstack/react-table';
import { PageHeader } from '../_components/page-header';
import { UploadZone } from './_components/upload-zone';
import { DocumentFilters } from './_components/document-filters';
import { DocumentTable } from './_components/document-table';
import { BulkActions } from './_components/bulk-actions';
import { InboxTabs, type InboxTabKey } from './_components/inbox-tabs';
import { ScannerConfig } from './_components/scanner-config';
import { EmailConfig } from './_components/email-config';
import {
  useDocumentsList,
  useReExtractAllDocuments,
} from './_components/use-documents';
import type { DocumentFiltersState, DocumentOrigin, DocumentType, FiscalStatus } from './_components/types';

const PAGE_SIZE = 20;

const TAB_ORIGINS: Record<InboxTabKey, DocumentOrigin[] | undefined> = {
  todas: undefined,
  encomendas: undefined,
  email: ['EMAIL', 'GMAIL', 'OUTLOOK', 'INBOUND_WEBHOOK'],
  onedrive: ['ONEDRIVE'],
  scanner: ['SCANNER'],
  pdf: ['UPLOAD'],
  whatsapp: ['WHATSAPP'],
  nao_aplicavel: undefined,
};

const TAB_FISCAL_STATUS: Record<InboxTabKey, FiscalStatus | ''> = {
  todas: '',
  encomendas: '',
  email: '',
  onedrive: '',
  scanner: '',
  pdf: '',
  whatsapp: '',
  nao_aplicavel: 'NAO_APLICAVEL',
};

const TAB_DOCUMENT_TYPE: Record<InboxTabKey, DocumentType | ''> = {
  todas: '',
  encomendas: 'ENCOMENDA',
  email: '',
  onedrive: '',
  scanner: '',
  pdf: '',
  whatsapp: '',
  nao_aplicavel: '',
};

const TAB_EXCLUDE_TYPE: Record<InboxTabKey, DocumentType | ''> = {
  todas: 'ENCOMENDA',
  encomendas: '',
  email: 'ENCOMENDA',
  onedrive: 'ENCOMENDA',
  scanner: 'ENCOMENDA',
  pdf: 'ENCOMENDA',
  whatsapp: 'ENCOMENDA',
  nao_aplicavel: '',
};

const INITIAL_FILTERS: DocumentFiltersState = {
  search: '',
  status: '',
  type: '',
  excludeType: '',
  fiscalStatus: '',
  dateFrom: '',
  dateTo: '',
};

export default function DocumentsPage() {
  const [tab, setTab] = useState<InboxTabKey>('todas');
  const [filters, setFilters] = useState<DocumentFiltersState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<RowSelectionState>({});

  const tabOrigins = TAB_ORIGINS[tab];
  const tabFiscalStatus = TAB_FISCAL_STATUS[tab];
  const tabType = TAB_DOCUMENT_TYPE[tab];
  const tabExcludeType = TAB_EXCLUDE_TYPE[tab];
  const mergedFilters: DocumentFiltersState = {
    ...filters,
    origin: tabOrigins,
    fiscalStatus: tabFiscalStatus || filters.fiscalStatus || '',
    type: tabType || filters.type || '',
    excludeType: tabExcludeType || filters.excludeType || '',
  };

  const { data, isLoading, isError, refetch, isFetching } = useDocumentsList(
    mergedFilters,
    page,
    PAGE_SIZE,
  );

  const items = data?.items ?? [];
  const total = data?.meta?.total ?? 0;

  const selectedIds = Object.entries(selection)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const resetSelection = () => setSelection({});

  const reExtractAll = useReExtractAllDocuments();
  const handleReprocessAll = async () => {
    if (
      !window.confirm(
        'Deseja reprocessar todos os documentos existentes com o novo motor Sharp e salvaguarda do NIF da empresa?\n\nIsto irá atualizar os PDFs de arquivo, endireitar fotografias e recalcular a certeza fiscal de cada documento.',
      )
    ) {
      return;
    }
    try {
      const res = await reExtractAll.mutateAsync();
      alert(`Reprocessamento em lote iniciado para ${res.queuedCount} documento(s)!`);
      refetch();
    } catch {
      alert('Falha ao iniciar o reprocessamento em lote.');
    }
  };

  return (
    <>
      <PageHeader
        title="Documentos"
        subtitle="Inbox documental com extração IA — faturas, recibos e notas."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary text-sm inline-flex items-center gap-1.5"
              onClick={handleReprocessAll}
              disabled={reExtractAll.isPending || isFetching}
              title="Reprocessar todos os documentos com Sharp e salvaguarda fiscal"
            >
              <Sparkles size={14} className={reExtractAll.isPending ? 'animate-spin' : ''} />
              {reExtractAll.isPending ? 'A reprocessar…' : 'Reprocessar Todos'}
            </button>
            <button
              type="button"
              className="btn-secondary text-sm inline-flex items-center gap-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="Atualizar lista"
            >
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
              Atualizar
            </button>
          </div>
        }
      />

      <div className="space-y-5">
        <InboxTabs active={tab} onChange={(next) => {
          setTab(next);
          setPage(1);
          setSelection({});
        }} />

        {(tab === 'todas' || tab === 'pdf') && <UploadZone />}
        {tab === 'scanner' && <ScannerConfig />}
        {tab === 'email' && <EmailConfig />}

        {tab === 'onedrive' && (
          <div className="card p-4 flex items-center justify-between gap-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.25)' }}
              >
                <Cloud size={20} style={{ color: 'var(--accent)' }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  OneDrive Empresarial (Microsoft Graph)
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Pasta monitorizada: <code className="px-1 py-0.5 rounded bg-surface border text-xs">/DocFlow/Entrada</code>. Ficheiros processados são transferidos automaticamente para <code className="px-1 py-0.5 rounded bg-surface border text-xs">/DocFlow/Processados</code>.
                </p>
              </div>
            </div>
            <span className="badge-emerald text-xs font-medium">Sincronização 2m</span>
          </div>
        )}

        {tab === 'whatsapp' && (
          <div className="card p-4 flex items-center justify-between gap-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)' }}
              >
                <MessageSquare size={20} style={{ color: 'var(--emerald)' }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Canal WhatsApp (Evolution API)
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Webhook de entrada: <code className="px-1 py-0.5 rounded bg-surface border text-xs">/api/v1/inbound/whatsapp</code>. PDFs e fotografias recebidos via WhatsApp convergem automaticamente no mesmo circuito com deduplicação SHA-256.
                </p>
              </div>
            </div>
            <span className="badge-emerald text-xs font-medium">Webhook Ativo</span>
          </div>
        )}

        {tab === 'nao_aplicavel' && (
          <div className="card p-4 flex items-center justify-between gap-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)' }}
              >
                <ShoppingCart size={20} style={{ color: 'var(--violet)' }} />
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Encomendas de Clientes & Documentos Próprios
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Documentos onde a empresa (NIF 515208566) figura como emitente/vendedor ou identificados como notas de encomenda de clientes. Mantidos isolados das compras para proteger o apuramento de IVA dedutível.
                </p>
              </div>
            </div>
            <span className="badge-violet text-xs font-medium">Isolado de Compras</span>
          </div>
        )}

        <DocumentFilters value={filters} onChange={(next) => {
          setFilters(next);
          setPage(1);
        }} total={total} />

        {isError ? (
          <div
            className="card p-6 flex items-start gap-3"
            role="alert"
            style={{
              background: 'rgba(248,113,113,0.08)',
              borderColor: 'rgba(248,113,113,0.30)',
            }}
          >
            <AlertCircle size={18} style={{ color: 'var(--danger)' }} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--danger-fg)' }}>
                Não foi possível carregar os documentos
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Verifique a sua ligação ou tente novamente.
              </p>
            </div>
            <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => refetch()}>
              Tentar novamente
            </button>
          </div>
        ) : (
          <DocumentTable
            data={items}
            loading={isLoading}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            selection={selection}
            onSelectionChange={setSelection}
            onPageChange={setPage}
          />
        )}
      </div>

      <BulkActions selectedIds={selectedIds} onClear={resetSelection} />
    </>
  );
}
