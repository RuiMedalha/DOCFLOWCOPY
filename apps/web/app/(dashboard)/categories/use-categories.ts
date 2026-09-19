'use client';

/**
 * useCategories — list + CRUD hook for expense categories.
 *
 * Backend (live-verified, REST):
 *   GET    /api/v1/categories        → ExpenseCategory[]   (any authenticated user)
 *   POST   /api/v1/categories        → ExpenseCategory     (ADMIN only)
 *   PATCH  /api/v1/categories/:id    → ExpenseCategory     (ADMIN only)
 *   DELETE /api/v1/categories/:id    → 204                 (ADMIN only)
 *
 * Uses the project's `http` wrapper (apps/web/app/_lib/http.ts) which
 * handles Authorization + 401 refresh + envelope unwrap — we never
 * reimplement fetch here.
 */

import { useCallback, useEffect, useState } from 'react';
import { http } from '../../_lib/http';

export interface ExpenseCategory {
  id: string;
  name: string;
  slug: string;
  /** Fase 4.1 — eixo contabilístico (mercadorias / FSE / despesa / imobilizado). */
  nature?:
    | 'MERCADORIAS_REVENDA'
    | 'MATERIAS_PRIMAS_SUBSIDIARIAS'
    | 'SERVICOS_EXTERNOS'
    | 'DESPESA_OPERACIONAL'
    | 'IMOBILIZADO';
  color?: string | null;
  defaultIvaDeductibilityPct?: number | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface CategoryDraft {
  name: string;
  slug: string;
  color?: string;
  defaultIvaDeductibilityPct?: number;
  notes?: string;
}

export interface UseCategories {
  categories: ExpenseCategory[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createCategory: (draft: CategoryDraft) => Promise<ExpenseCategory>;
  updateCategory: (id: string, patch: Partial<CategoryDraft>) => Promise<ExpenseCategory>;
  deleteCategory: (id: string) => Promise<void>;
  // In-flight tracking so the page can show spinners / disable inputs.
  savingId: string | null;
  deletingId: string | null;
  creating: boolean;
}

export function useCategories(): UseCategories {
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await http.get<ExpenseCategory[]>('/categories');
      setCategories(Array.isArray(list) ? list : []);
    } catch (err: any) {
      const raw = typeof err?.message === 'string' ? err.message : '';
      setError(raw || 'Falha ao carregar categorias.');
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount (per the brief: useEffect + the hook, no TanStack Query).
  useEffect(() => {
    void reload();
  }, [reload]);

  const createCategory = useCallback(
    async (draft: CategoryDraft): Promise<ExpenseCategory> => {
      setCreating(true);
      try {
        const created = await http.post<ExpenseCategory>('/categories', draft);
        // Optimistic insert at the top — keep list sorted by name locally
        // (server doesn't guarantee order).
        setCategories((prev) => {
          const next = [created, ...prev.filter((c) => c.id !== created.id)];
          return next.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
        });
        return created;
      } finally {
        setCreating(false);
      }
    },
    [],
  );

  const updateCategory = useCallback(
    async (id: string, patch: Partial<CategoryDraft>): Promise<ExpenseCategory> => {
      setSavingId(id);
      try {
        const updated = await http.patch<ExpenseCategory>(`/categories/${id}`, patch);
        setCategories((prev) =>
          prev
            .map((c) => (c.id === id ? updated : c))
            .sort((a, b) => a.name.localeCompare(b.name, 'pt')),
        );
        return updated;
      } finally {
        setSavingId(null);
      }
    },
    [],
  );

  const deleteCategory = useCallback(async (id: string): Promise<void> => {
    setDeletingId(id);
    try {
      await http.del<void>(`/categories/${id}`);
      setCategories((prev) => prev.filter((c) => c.id !== id));
    } finally {
      setDeletingId(null);
    }
  }, []);

  return {
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
  };
}