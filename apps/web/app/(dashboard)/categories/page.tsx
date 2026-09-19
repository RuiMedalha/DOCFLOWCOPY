'use client';

/**
 * /categories — expense category management.
 *
 * Lists the 9 PT seeded buckets (Refeições, Combustível, …) for any
 * authenticated user; ADMINs additionally get Add / Edit / Delete.
 * Backend auto-seeds the default buckets on first GET for the tenant.
 *
 * Mutations:
 *   POST   /api/v1/categories        (ADMIN only)
 *   PATCH  /api/v1/categories/:id    (ADMIN only)
 *   DELETE /api/v1/categories/:id    (ADMIN only)
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Tags,
  X,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { PageHeader } from '../_components/page-header';
import { useUser } from '@/_lib/use-dashboard-queries';
import {
  useCategories,
  type ExpenseCategory,
  type CategoryDraft,
} from './use-categories';

type Toast =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string };

export default function CategoriesPage() {
  const user = useUser();
  const isAdmin = user?.role === 'ADMIN';
  const {
    categories,
    loading,
    error,
    reload,
    createCategory,
    updateCategory,
    deleteCategory,
    savingId,
    deletingId,
    creating,
  } = useCategories();

  const [toast, setToast] = useState<Toast | null>(null);

  // Modal state — null = closed.
  const [editing, setEditing] = useState<ExpenseCategory | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ExpenseCategory | null>(null);

  // Auto-dismiss toast after 3s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (kind: Toast['kind'], text: string) => setToast({ kind, text });

  const handleCreate = async (draft: CategoryDraft) => {
    try {
      await createCategory(draft);
      setEditing(null);
      showToast('success', `Categoria "${draft.name}" criada.`);
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      showToast('error', raw || 'Falha ao criar categoria.');
    }
  };

  const handleUpdate = async (id: string, patch: Partial<CategoryDraft>) => {
    try {
      const updated = await updateCategory(id, patch);
      setEditing(null);
      showToast('success', `Categoria "${updated.name}" atualizada.`);
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      showToast('error', raw || 'Falha ao atualizar categoria.');
    }
  };

  const handleDelete = async (cat: ExpenseCategory) => {
    try {
      await deleteCategory(cat.id);
      setConfirmDelete(null);
      showToast('success', `Categoria "${cat.name}" removida.`);
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      showToast('error', raw || 'Falha ao remover categoria.');
    }
  };

  const sorted = useMemo(
    () => [...categories].sort((a, b) => a.name.localeCompare(b.name, 'pt')),
    [categories],
  );

  return (
    <>
      <PageHeader
        title="Categorias de despesa"
        subtitle="9 categorias PT pré-carregadas por defeito. Administradores podem adicionar, editar ou remover."
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="btn-primary text-sm"
              disabled={creating}
            >
              <Plus size={14} aria-hidden="true" />
              Adicionar categoria
            </button>
          ) : null
        }
      />

      {/* Inline toast — per brief, no external lib. */}
      {toast && <ToastStrip toast={toast} onClose={() => setToast(null)} />}

      {error && (
        <div
          role="alert"
          className="card p-3 mb-4 flex items-center gap-2"
          style={{
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            color: 'var(--danger)',
          }}
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="text-sm">{error}</span>
          <button
            type="button"
            onClick={() => void reload()}
            className="ml-auto text-xs underline"
          >
            Tentar novamente
          </button>
        </div>
      )}

      <section className="card p-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Tags size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-subtle)' }}>
            Categorias ({sorted.length})
          </h2>
        </div>

        {loading ? (
          <SkeletonRows />
        ) : sorted.length === 0 ? (
          <EmptyState onReload={() => void reload()} />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-subtle)' }}>
                <th className="text-left font-medium px-4 py-2 w-8" />
                <th className="text-left font-medium px-2 py-2">Nome</th>
                <th className="text-left font-medium px-2 py-2">Slug</th>
                <th className="text-right font-medium px-2 py-2 tabular-nums">IVA dedutível</th>
                <th className="text-left font-medium px-2 py-2">Notas</th>
                {isAdmin && <th className="w-20 px-2 py-2" aria-label="Ações" />}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-4 py-2">
                    <ColorSwatch color={c.color} />
                  </td>
                  <td className="px-2 py-2 font-medium" style={{ color: 'var(--text)' }}>
                    {c.name}
                  </td>
                  <td className="px-2 py-2 font-mono" style={{ color: 'var(--text-muted)' }}>
                    {c.slug}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {c.defaultIvaDeductibilityPct != null ? `${c.defaultIvaDeductibilityPct}%` : '—'}
                  </td>
                  <td className="px-2 py-2 truncate max-w-[280px]" style={{ color: 'var(--text-muted)' }}>
                    {c.notes ?? '—'}
                  </td>
                  {isAdmin && (
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          disabled={savingId === c.id || deletingId === c.id}
                          aria-label={`Editar ${c.name}`}
                          className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--hover)] transition-colors"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(c)}
                          disabled={deletingId === c.id}
                          aria-label={`Remover ${c.name}`}
                          className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--hover)] transition-colors"
                          style={{ color: 'var(--danger)' }}
                        >
                          {deletingId === c.id ? (
                            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 size={12} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <CategoryModal
          initial={editing === 'new' ? null : editing}
          busy={creating || savingId === (editing === 'new' ? '' : editing.id)}
          onCancel={() => setEditing(null)}
          onSubmit={(draft) => {
            if (editing === 'new') {
              void handleCreate(draft);
            } else {
              void handleUpdate(editing.id, draft);
            }
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Remover categoria?"
          description={`Esta ação não pode ser revertida. A categoria "${confirmDelete.name}" deixará de estar disponível para classificar novos documentos.`}
          busy={deletingId === confirmDelete.id}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void handleDelete(confirmDelete)}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------------------------------- toast

function ToastStrip({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const isOk = toast.kind === 'success';
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3.5 py-2.5 rounded-lg shadow-lg animate-pop"
      style={{
        background: 'var(--bg-card-solid)',
        border: `1px solid ${isOk ? 'var(--success)' : 'var(--danger)'}`,
        color: isOk ? 'var(--success)' : 'var(--danger)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      {isOk ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
      <span className="text-sm">{toast.text}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar"
        className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-[var(--hover)]"
      >
        <X size={11} aria-hidden="true" />
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- swatch

function ColorSwatch({ color }: { color?: string | null }) {
  if (!color) {
    return (
      <span
        aria-hidden="true"
        className="inline-block w-3 h-3 rounded-sm"
        style={{ background: 'var(--hover)' }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block w-3 h-3 rounded-sm"
      style={{ background: color }}
      title={color}
    />
  );
}

// --------------------------------------------------------------------------------------------- modal

function CategoryModal({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: ExpenseCategory | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: CategoryDraft) => void;
}) {
  const isNew = initial === null;
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [color, setColor] = useState(initial?.color ?? '#64748b');
  const [ivaPct, setIvaPct] = useState<string>(
    initial?.defaultIvaDeductibilityPct != null ? String(initial.defaultIvaDeductibilityPct) : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');

  // Auto-derive slug from name on create only.
  useEffect(() => {
    if (!isNew) return;
    if (slug && slug !== slugify(name)) return; // user has edited manually
    setSlug(slugify(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName || !trimmedSlug) return;
    const draft: CategoryDraft = {
      name: trimmedName,
      slug: trimmedSlug,
      color: color.trim() || undefined,
      defaultIvaDeductibilityPct:
        ivaPct.trim() === '' ? undefined : Math.max(0, Math.min(100, Number(ivaPct))),
      notes: notes.trim() || undefined,
    };
    onSubmit(draft);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'Nova categoria' : 'Editar categoria'}
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(2, 6, 23, 0.55)' }}
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="card-solid w-full max-w-md p-5 space-y-3"
        style={{ background: 'var(--bg-card-solid)' }}
      >
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {isNew ? 'Nova categoria' : 'Editar categoria'}
        </h3>

        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Nome
          </label>
          <input
            type="text"
            className="input mt-1 w-full"
            value={name}
            required
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Refeições"
          />
        </div>

        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Slug
          </label>
          <input
            type="text"
            className="input mt-1 w-full font-mono"
            value={slug}
            required
            maxLength={80}
            pattern="[a-z0-9\-]+"
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="refeicoes"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Cor
            </label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-9 h-9 rounded border-0 p-0 cursor-pointer"
                aria-label="Cor da categoria"
              />
              <input
                type="text"
                className="input flex-1 font-mono"
                value={color}
                maxLength={16}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#64748b"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              IVA dedutível (%)
            </label>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={1}
              className="input mt-1 w-full tabular-nums"
              value={ivaPct}
              onChange={(e) => setIvaPct(e.target.value)}
              placeholder="Ex.: 50"
            />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Notas
          </label>
          <textarea
            className="input mt-1 w-full"
            value={notes}
            rows={3}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notas internas (opcional)"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary text-sm" disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {isNew ? 'Criar' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmModal({
  title,
  description,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(2, 6, 23, 0.55)' }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-solid w-full max-w-sm p-5 space-y-3"
        style={{ background: 'var(--bg-card-solid)' }}
      >
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text)' }}>
          <AlertTriangle size={14} aria-hidden="true" style={{ color: 'var(--danger)' }} />
          {title}
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {description}
        </p>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn-primary text-sm"
            disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
            Remover
          </button>
        </div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-9 rounded animate-pulse"
          style={{ background: 'var(--hover)' }}
        />
      ))}
    </div>
  );
}

function EmptyState({ onReload }: { onReload: () => void }) {
  return (
    <div className="p-10 text-center">
      <Tags size={24} aria-hidden="true" style={{ color: 'var(--text-subtle)' }} className="mx-auto" />
      <p className="text-sm mt-3" style={{ color: 'var(--text-muted)' }}>
        Sem categorias. As 9 categorias PT padrão serão criadas no primeiro GET.
      </p>
      <button type="button" onClick={onReload} className="btn-secondary text-sm mt-3">
        Recarregar
      </button>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    // Strip combining diacritical marks (U+0300–U+036F).
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}