'use client';

/**
 * DocFlow — DocumentTable.
 *
 * TanStack Table with columns: file, type, supplier, NIF, ATCUD, date,
 * total, IVA, status (+ fiscal validity), folder. Supports selection (used by bulk actions),
 * empty/loading states, and pagination via the parent.
 */

import { useMemo } from 'react';
import Link from 'next/link';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type RowSelectionState,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown, FileText, Folder } from 'lucide-react';
import {
  DOCUMENT_STATUS_LABEL,
  DOCUMENT_TYPE_LABEL,
  FISCAL_STATUS_BADGE,
  FISCAL_STATUS_LABEL,
  type DocumentOrigin,
  type DocumentRecord,
  type DocumentStatus,
} from './types';

const STATUS_BADGE: Record<DocumentStatus, string> = {
  NOVO: 'badge-amber',
  PROCESSADO: 'badge-emerald',
  EM_REVISAO: 'badge-sky',
  APROVADO: 'badge-emerald',
  REJEITADO: 'badge-rose',
  ARQUIVADO: 'badge-violet',
  PENDING_APPROVAL: 'badge-amber',
  CHANGES_REQUESTED: 'badge-amber',
  DUPLICADO: 'badge-rose',
};

/**
 * Sprint F — colour-coded badge for the inbound channel. The badge
 * styling piggybacks on the existing badge-* tokens so no new design
 * tokens need to ship.
 */
const ORIGIN_BADGE: Record<DocumentOrigin, { label: string; cls: string }> = {
  UPLOAD: { label: 'PDF', cls: 'badge-sky' },
  SCANNER: { label: 'Scanner', cls: 'badge-amber' },
  EMAIL: { label: 'Email', cls: 'badge-violet' },
  INBOUND_WEBHOOK: { label: 'Email', cls: 'badge-violet' },
  GMAIL: { label: 'Gmail', cls: 'badge-violet' },
  OUTLOOK: { label: 'Outlook', cls: 'badge-violet' },
  MOBILE: { label: 'Mobile', cls: 'badge-sky' },
  WHATSAPP: { label: 'WhatsApp', cls: 'badge-emerald' },
  API: { label: 'API', cls: 'badge-sky' },
  ONEDRIVE: { label: 'OneDrive', cls: 'badge-sky' },
};

const columnHelper = createColumnHelper<DocumentRecord>();

function formatCurrency(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-PT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentTable({
  data,
  loading,
  page,
  pageSize,
  total,
  selection,
  onSelectionChange,
  onPageChange,
}: {
  data: DocumentRecord[];
  loading: boolean;
  page: number;
  pageSize: number;
  total: number;
  selection: RowSelectionState;
  onSelectionChange: (next: RowSelectionState) => void;
  onPageChange: (page: number) => void;
}) {
  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()}
            onChange={(v) => table.toggleAllRowsSelected(v)}
            ariaLabel="Selecionar todas as linhas"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onChange={(v) => row.toggleSelected(v)}
            ariaLabel={`Selecionar ${row.original.fileName}`}
          />
        ),
        size: 36,
        enableSorting: false,
      }),
      columnHelper.accessor('fileName', {
        header: 'Ficheiro',
        cell: ({ row }) => (
          <Link
            href={`/documents/${row.original.id}`}
            className="flex items-center gap-2.5 group min-w-0"
          >
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105"
              style={{
                background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(129,140,248,0.10))',
                border: '1px solid rgba(56,189,248,0.25)',
              }}
            >
              <FileText size={15} style={{ color: 'var(--accent)' }} />
            </div>
            <div className="min-w-0">
              <p
                className="font-medium text-sm truncate group-hover:text-sky-400 transition-colors"
                style={{ color: 'var(--text)' }}
              >
                {row.original.fileName}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-subtle)' }}>
                {formatSize(row.original.fileSize)}
                {row.original.rank != null ? ` · Relevância ${row.original.rank.toFixed(3)}` : ''}
              </p>
            </div>
          </Link>
        ),
      }),
      columnHelper.accessor('type', {
        header: 'Tipo',
        cell: ({ getValue }) => (
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {DOCUMENT_TYPE_LABEL[getValue()] ?? getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('supplier', {
        header: 'Fornecedor',
        cell: ({ getValue }) => (
          <span className="text-sm" style={{ color: 'var(--text)' }}>
            {getValue() ?? '—'}
          </span>
        ),
      }),
      columnHelper.accessor('supplierNif', {
        header: 'NIF',
        cell: ({ getValue }) => {
          const val = getValue();
          if (!val) {
            return (
              <span className="text-xs font-semibold text-rose-600 inline-flex items-center gap-1 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">
                ⚠️ Em falta
              </span>
            );
          }
          return (
            <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {val}
            </span>
          );
        },
      }),
      // Fase 4.1 — o ATCUD estava só no detalhe; na listagem é o que
      // distingue de relance um documento certificado pela AT.
      columnHelper.accessor('atcud', {
        header: 'ATCUD',
        cell: ({ getValue }) => (
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {getValue() ?? '—'}
          </span>
        ),
      }),
      columnHelper.accessor('docDate', {
        header: 'Data',
        cell: ({ getValue }) => (
          <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {formatDate(getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('total', {
        header: 'Total',
        cell: ({ getValue }) => (
          <span className="text-sm tabular-nums font-medium" style={{ color: 'var(--text)' }}>
            {formatCurrency(getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('taxAmount', {
        header: 'IVA',
        cell: ({ getValue }) => (
          <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {formatCurrency(getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Estado',
        cell: ({ getValue, row }) => {
          const v = getValue();
          const fiscal = row.original.fiscalStatus;
          const fiscalReason = row.original.fiscalReason ?? '';
          const isNaoAplicavel = fiscal === 'NAO_APLICAVEL';
          const hasNifProblem =
            !isNaoAplicavel &&
            (fiscal === 'NAO_FISCAL' ||
              (v === 'EM_REVISAO' && (!row.original.supplierNif || /nif|consumidor|civa/i.test(fiscalReason))));

          return (
            <span className="inline-flex flex-wrap items-center gap-1">
              {row.original.duplicateOfId ? (
                <Link
                  href={`/documents/${row.original.duplicateOfId}`}
                  className={STATUS_BADGE[v]}
                  title="Duplicado — abrir o documento original"
                >
                  {DOCUMENT_STATUS_LABEL[v] ?? v}
                </Link>
              ) : hasNifProblem ? (
                <span
                  className="badge-rose font-medium inline-flex items-center gap-1"
                  title={fiscalReason || 'Requer revisão: NIF da empresa ou fornecedor em falta/inválido'}
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                  {fiscal === 'NAO_FISCAL' ? 'Não fiscal' : 'Atenção: Sem NIF'}
                </span>
              ) : (
                <span className={STATUS_BADGE[v]}>{DOCUMENT_STATUS_LABEL[v] ?? v}</span>
              )}
              {/* Fase 3 — validade fiscal determinística; INDETERMINADO fica implícito */}
              {fiscal && fiscal !== 'INDETERMINADO' && !hasNifProblem && (
                <span
                  className={FISCAL_STATUS_BADGE[fiscal]}
                  title={
                    isNaoAplicavel
                      ? 'Documento emitido pela própria empresa ou nota de encomenda de cliente (fora do circuito de compras/IVA dedutível).'
                      : fiscalReason || undefined
                  }
                >
                  {FISCAL_STATUS_LABEL[fiscal]}
                </span>
              )}
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.folder?.name ?? null, {
        id: 'folder',
        header: 'Pasta',
        cell: ({ row }) => (
          <span
            className="inline-flex items-center gap-1.5 text-sm"
            style={{ color: 'var(--text-muted)' }}
          >
            <Folder size={12} style={{ color: 'var(--text-subtle)' }} />
            {row.original.folder?.name ?? '—'}
          </span>
        ),
      }),
      columnHelper.accessor('origin', {
        id: 'origin',
        header: 'Canal',
        cell: ({ getValue, row }) => {
          const v = getValue();
          if (!v) return <span style={{ color: 'var(--text-subtle)' }}>—</span>;
          const meta = ORIGIN_BADGE[v];
          const md = row.original.metadata as Record<string, any> | undefined;
          let tooltip: string | undefined;
          if (md) {
            if (md.originalSender || md.sender) {
              tooltip = `Remetente: ${md.originalSender || md.sender}`;
              if (md.mailbox) tooltip += ` | Caixa: ${md.mailbox}`;
              if (md.originalSubject) tooltip += ` | Assunto: ${md.originalSubject}`;
            } else if (md.sourceFile || md.path) {
              tooltip = `Caminho: ${md.sourceFile || md.path}`;
            } else if (md.scannerId) {
              tooltip = `Scanner: ${md.scannerId}`;
            }
          }
          return meta ? (
            <span className={meta.cls} title={tooltip}>{meta.label}</span>
          ) : (
            <span className="badge-sky" title={tooltip}>{v}</span>
          );
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { rowSelection: selection },
    enableRowSelection: true,
    onRowSelectionChange: (updater) => {
      // When state is controlled, the updater receives the new state directly.
      const next = typeof updater === 'function' ? updater(selection) : updater;
      onSelectionChange(next as RowSelectionState);
    },
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    getRowId: (row) => row.id,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3 animate-in animate-delay-2">
      <div
        className="card overflow-hidden"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        className="text-left text-xs font-medium uppercase tracking-wider px-3.5 py-3 select-none"
                        style={{
                          color: 'var(--text-subtle)',
                          width: header.column.columnDef.size ?? undefined,
                        }}
                      >
                        {header.isPlaceholder
                          ? null
                          : canSort
                            ? (
                              <button
                                type="button"
                                onClick={header.column.getToggleSortingHandler()}
                                className="inline-flex items-center gap-1 cursor-pointer hover:opacity-70 transition-opacity"
                                style={{ color: 'inherit' }}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {sorted === 'asc' ? (
                                  <ChevronUp size={12} />
                                ) : sorted === 'desc' ? (
                                  <ChevronDown size={12} />
                                ) : (
                                  <ChevronsUpDown size={12} />
                                )}
                              </button>
                            )
                            : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    {columns.map((_, j) => (
                      <td key={j} className="px-3.5 py-3.5">
                        <div className="skeleton h-4" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-3.5 py-16 text-center">
                    <div
                      className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-3"
                      style={{ background: 'var(--hover)' }}
                    >
                      <FileText size={20} style={{ color: 'var(--text-subtle)' }} />
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      Sem documentos com os filtros atuais.
                    </p>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const doc = row.original;
                  const hasNifProblem =
                    doc.fiscalStatus === 'NAO_FISCAL' ||
                    (doc.status === 'EM_REVISAO' && (!doc.supplierNif || /nif|consumidor|civa/i.test(doc.fiscalReason ?? '')));

                  return (
                    <tr
                      key={row.id}
                      style={{
                        borderBottom: '1px solid var(--border)',
                        borderLeft: hasNifProblem ? '3px solid #F43F5E' : '3px solid transparent',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = hasNifProblem
                          ? 'rgba(244, 63, 94, 0.08)'
                          : 'var(--hover)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = hasNifProblem
                          ? 'rgba(244, 63, 94, 0.03)'
                          : 'transparent';
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3.5 py-3 align-middle">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && data.length > 0 && (
        <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="tabular-nums">
            Página {page} de {totalPages} · {total} no total
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
            >
              Anterior
            </button>
            <button
              type="button"
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
            >
              Seguinte
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Checkbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="w-4 h-4 rounded-md border flex items-center justify-center transition-colors"
      style={{
        borderColor: checked || indeterminate ? 'var(--accent)' : 'var(--border-strong)',
        background: checked || indeterminate ? 'var(--accent)' : 'transparent',
      }}
    >
      {checked && (
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path
            d="M3 8.5l3.2 3.2L13 4.8"
            stroke="#020617"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      )}
      {indeterminate && (
        <span
          aria-hidden="true"
          className="block w-2 h-0.5 rounded-full"
          style={{ background: '#020617' }}
        />
      )}
    </button>
  );
}
