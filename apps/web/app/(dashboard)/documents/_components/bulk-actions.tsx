'use client';

/**
 * DocFlow — BulkActions.
 *
 * Floating action bar shown when at least one row is selected. Offers
 * folder assignment, tagging, and (with confirm) deletion.
 */

import { useState } from 'react';
import { Folder, Tag, Trash2, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { useBulkUpdateDocuments, useFolders, useReExtractBatchDocuments } from './use-documents';

export function BulkActions({
  selectedIds,
  onClear,
}: {
  selectedIds: string[];
  onClear: () => void;
}) {
  const folders = useFolders();
  const bulk = useBulkUpdateDocuments();
  const reExtractBatch = useReExtractBatchDocuments();
  const [folderId, setFolderId] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (selectedIds.length === 0) return null;

  const applyReExtract = () => {
    reExtractBatch.mutate(selectedIds, {
      onSuccess: () => {
        onClear();
      },
    });
  };

  const applyFolder = () => {
    if (!folderId) return;
    bulk.mutate(
      { ids: selectedIds, action: 'folder', folderId },
      { onSuccess: () => setFolderId('') },
    );
  };

  const applyTags = () => {
    const tags = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.length) return;
    bulk.mutate(
      { ids: selectedIds, action: 'tag', tags },
      { onSuccess: () => setTagInput('') },
    );
  };

  const applyDelete = () => {
    bulk.mutate(
      { ids: selectedIds, action: 'delete' },
      {
        onSuccess: () => {
          setConfirmDelete(false);
          onClear();
        },
      },
    );
  };

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 card-solid shadow-2xl animate-in"
      role="region"
      aria-label="Ações em massa"
      style={{
        background: 'var(--bg-card-solid)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45), 0 0 40px rgba(56,189,248,0.10)',
        minWidth: 540,
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="badge-sky">{selectedIds.length} selecionado(s)</span>

        <div className="h-6 w-px" style={{ background: 'var(--border)' }} />

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Folder size={14} style={{ color: 'var(--text-muted)' }} />
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="input py-1.5 text-xs flex-1 min-w-0"
            aria-label="Selecionar pasta"
          >
            <option value="">Mover para pasta…</option>
            {folders.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary text-xs px-2.5 py-1.5"
            disabled={!folderId || bulk.isPending}
            onClick={applyFolder}
          >
            Aplicar
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Tag size={14} style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder="tag1, tag2…"
            className="input py-1.5 text-xs w-32"
            aria-label="Tags a aplicar"
          />
          <button
            type="button"
            className="btn-secondary text-xs px-2.5 py-1.5"
            disabled={!tagInput.trim() || bulk.isPending}
            onClick={applyTags}
          >
            Etiquetar
          </button>
        </div>

        <div className="h-6 w-px" style={{ background: 'var(--border)' }} />

        <button
          type="button"
          className="btn-secondary text-xs px-2.5 py-1.5 inline-flex items-center gap-1.5"
          onClick={applyReExtract}
          disabled={reExtractBatch.isPending}
          title="Re-extrair documentos selecionados com o novo motor Sharp e salvaguarda do NIF"
        >
          <RefreshCw size={12} className={reExtractBatch.isPending ? 'animate-spin' : ''} />
          {reExtractBatch.isPending ? 'A processar…' : 'Re-extrair'}
        </button>

        <button
          type="button"
          className="btn-danger text-xs px-2.5 py-1.5"
          onClick={() => setConfirmDelete(true)}
          disabled={bulk.isPending}
        >
          <Trash2 size={12} /> Eliminar
        </button>

        <button
          type="button"
          onClick={onClear}
          className="p-1.5 rounded-md hover:bg-[var(--hover)]"
          aria-label="Limpar seleção"
        >
          <X size={14} style={{ color: 'var(--text-subtle)' }} />
        </button>
      </div>

      {confirmDelete && (
        <div
          className="px-4 py-3 flex items-center gap-3"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
          <p className="text-sm flex-1" style={{ color: 'var(--text)' }}>
            Eliminar {selectedIds.length} documento(s)? Esta ação é irreversível.
          </p>
          <button
            type="button"
            className="btn-ghost text-xs px-3 py-1.5"
            onClick={() => setConfirmDelete(false)}
            disabled={bulk.isPending}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn-danger text-xs px-3 py-1.5"
            onClick={applyDelete}
            disabled={bulk.isPending}
          >
            {bulk.isPending ? 'A eliminar…' : 'Confirmar eliminação'}
          </button>
        </div>
      )}
    </div>
  );
}
