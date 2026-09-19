'use client';

/**
 * DocFlow — Document Inbox data hooks.
 *
 * Talks to the backend `documents` module via `apiClient`. All requests
 * run through TanStack Query so we get caching, retries and optimistic
 * updates for free.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../../_lib/api-client';
import { authedFetch } from '../../../_lib/auth-refresh';
import { useAuthStore } from '../../../_lib/auth-store';
import type {
  DocumentFiltersState,
  DocumentListResponse,
  DocumentRecord,
} from './types';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) || 'http://localhost:4000/api/v1';

function buildQuery(
  filters: DocumentFiltersState,
  page: number,
  pageSize: number,
): string {
  const sp = new URLSearchParams();
  if (filters.search) sp.set('search', filters.search);
  if (filters.status) sp.set('status', filters.status);
  if (filters.type) sp.set('type', filters.type);
  if (filters.excludeType) sp.set('excludeType', filters.excludeType);
  if (filters.fiscalStatus) sp.set('fiscalStatus', filters.fiscalStatus);
  if (filters.dateFrom) sp.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) sp.set('dateTo', filters.dateTo);
  // Origin filter (Sprint F): the backend DTO accepts both CSV strings
  // and repeated query params; CSV is the more compact URL shape.
  if (filters.origin && filters.origin.length > 0) {
    sp.set('origin', filters.origin.join(','));
  }
  sp.set('page', String(page));
  // API DTO expects `limit`, not `pageSize` (forbidNonWhitelisted rejects it).
  sp.set('limit', String(pageSize));
  return sp.toString();
}

export const documentKeys = {
  all: ['documents'] as const,
  list: (filters: DocumentFiltersState, page: number, pageSize: number) =>
    ['documents', 'list', filters, page, pageSize] as const,
};

export function useDocumentsList(
  filters: DocumentFiltersState,
  page: number,
  pageSize = 20,
) {
  return useQuery<DocumentListResponse>({
    queryKey: documentKeys.list(filters, page, pageSize),
    queryFn: async () => {
      const qs = buildQuery(filters, page, pageSize);
      const res = await authedFetch(`${API_BASE}/documents?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: DocumentListResponse };
      // Defensive default: API not ready? Return an empty list.
      return json.data ?? { items: [], meta: { total: 0, page, limit: pageSize, totalPages: 0 } };
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export function useFolders() {
  return useQuery({
    queryKey: ['folders'],
    queryFn: async () => {
      const res = await authedFetch(`${API_BASE}/documents/folders`);
      if (!res.ok) return [] as Array<{ id: string; name: string; color?: string | null }>;
      const json = (await res.json()) as { data?: Array<{ id: string; name: string; color?: string | null }> };
      return json.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export interface UploadProgressEvent {
  fileName: string;
  progress: number;
  status: 'uploading' | 'done' | 'duplicate' | 'error';
  message?: string;
  /** When status === 'duplicate', the id of the document already on file. */
  existingId?: string;
  /** When status === 'duplicate', the filename the original upload was stored under. */
  existingFileName?: string;
}

export interface UploadInput {
  files: File[];
  onProgress?: (evt: UploadProgressEvent) => void;
}

/**
 * Upload a batch of files with per-file progress reporting.
 *
 * The backend is expected to respond 201 with `{ data: DocumentRecord }`
 * or 409 with `{ code: 'duplicate', data: { existingId } }` when a
 * duplicate is detected (we surface that as a warning, not an error).
 */
export function useUploadDocuments() {
  const queryClient = useQueryClient();
  return useMutation<
    { duplicates: DocumentRecord[]; created: DocumentRecord[] },
    Error,
    UploadInput
  >({
    mutationFn: async ({ files, onProgress }) => {
      const created: DocumentRecord[] = [];
      const duplicates: DocumentRecord[] = [];

      for (const file of files) {
        onProgress?.({ fileName: file.name, progress: 0, status: 'uploading' });

        const formData = new FormData();
        formData.append('file', file);

        const result = await new Promise<DocumentRecord | null>(async (resolve, reject) => {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/documents/upload`);
            const token = useAuthStore.getState().accessToken;
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.addEventListener('progress', (ev) => {
              if (ev.lengthComputable) {
                const pct = Math.round((ev.loaded / ev.total) * 100);
                onProgress?.({ fileName: file.name, progress: pct, status: 'uploading' });
              }
            });

            xhr.onload = () => {
              try {
                const body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
                if (xhr.status >= 200 && xhr.status < 300) {
                  const doc = (body?.data ?? body) as DocumentRecord;
                  onProgress?.({ fileName: file.name, progress: 100, status: 'done' });
                  resolve(doc);
                } else if (xhr.status === 409) {
                  // Backend (AllExceptionsFilter) forwards ConflictException
                  // detail fields (existingId, existingFileName) alongside
                  // message. Treat this as an informational outcome — the
                  // file was already stored — not a failure.
                  const existingId = body?.existingId as string | undefined;
                  const existingFileName = body?.existingFileName as string | undefined;
                  onProgress?.({
                    fileName: file.name,
                    progress: 100,
                    status: 'duplicate',
                    message: 'Este documento já foi carregado',
                    existingId,
                    existingFileName,
                  });
                  // Surface the existing record to the caller so list
                  // invalidations cover it without an extra fetch.
                  resolve(
                    existingId
                      ? ({ id: existingId, fileName: existingFileName ?? file.name } as DocumentRecord)
                      : null,
                  );
                } else {
                  onProgress?.({
                    fileName: file.name,
                    progress: 0,
                    status: 'error',
                    message: body?.message ?? `HTTP ${xhr.status}`,
                  });
                  reject(new Error(body?.message ?? `Upload falhou (HTTP ${xhr.status})`));
                }
              } catch (err) {
                reject(err instanceof Error ? err : new Error('Resposta inválida'));
              }
            };

            xhr.onerror = () => {
              onProgress?.({ fileName: file.name, progress: 0, status: 'error', message: 'Erro de rede' });
              reject(new Error('Erro de rede'));
            };

            xhr.send(formData);
          } catch (err) {
            reject(err instanceof Error ? err : new Error('Erro desconhecido'));
          }
        });

        if (result) {
          // Heuristic: duplicates come back without an `id` marker; the
          // server response of a 409 also carries the existing record.
          // We tag duplicates by checking the progress event.
          // For now, append to `created`; duplicates are filtered by the
          // progress status callback at the call-site.
          created.push(result);
        }
      }

      return { created, duplicates };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}

export function useBulkUpdateDocuments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      ids: string[];
      action: 'folder' | 'tag' | 'delete';
      folderId?: string;
      tags?: string[];
    }) => {
      const res = await authedFetch(`${API_BASE}/documents/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP ${res.status}`);
      }
      return true;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}

export function useReExtractAllDocuments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await authedFetch(`${API_BASE}/documents/batch/re-extract-all`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { queuedCount: number; status: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}

export function useReExtractBatchDocuments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.all(
        ids.map((id) =>
          authedFetch(`${API_BASE}/documents/${id}/re-extract`, {
            method: 'POST',
          }),
        ),
      );
      return results.length;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}

// Suppress an unused-import warning from build tools that don't tree-shake
// the apiClient reference yet (kept for future use as the endpoint set grows).
void apiClient;
