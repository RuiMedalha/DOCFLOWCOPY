'use client';

/**
 * Storage tree hook.
 *
 * Talks to `GET /storage/tree?path=<rel>` on the backend. The backend
 * uses the authenticated user's tenantId — no client-side tenantId is
 * ever sent, so cross-tenant leakage is impossible from the client.
 *
 * Path normalization: the hook sends `/` for root and `/foo/bar` for
 * nested paths. The backend sanitizes again server-side (defence in depth).
 */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../../../_lib/auth-refresh';

const API_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) || 'http://localhost:4000/api/v1';

export interface FsEntry {
  name: string;
  /** Tenant-scoped POSIX path, e.g. `/fornecedores/acme/2026-09`. */
  path: string;
  kind: 'folder' | 'file';
  size?: number;
  modifiedAt?: string;
}

export interface StorageTree {
  path: string;
  parent: string | null;
  folders: FsEntry[];
  files: FsEntry[];
}

export const storageKeys = {
  tree: (path: string) => ['storage', 'tree', path] as const,
};

export function useStorageTree(path: string) {
  return useQuery<StorageTree>({
    queryKey: storageKeys.tree(path),
    queryFn: async () => {
      const qs = path && path !== '/' ? `?path=${encodeURIComponent(path)}` : '';
      const res = await authedFetch(`${API_BASE}/storage/tree${qs}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: StorageTree };
      return (
        json.data ?? {
          path: '/',
          parent: null,
          folders: [],
          files: [],
        }
      );
    },
    staleTime: 10_000,
  });
}

/**
 * Look up a documentId by its storage key. We don't expose the storage
 * tree as a generic file browser — the UI is for navigating to documents
 * that already exist. The mapping is on the document detail download
 * endpoint, which takes a documentId. For convenience, the storage page
 * accepts a `?doc=<id>` query and routes the click to `/documents/<id>`.
 *
 * Files are returned with their relative path; the user resolves a file
 * to a documentId by searching the inbox (which is keyed on fileName +
 * hash). For the MVP we just expose "open document by name" via the inbox.
 */
