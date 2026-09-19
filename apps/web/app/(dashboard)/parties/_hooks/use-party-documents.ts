'use client';

/**
 * usePartyDocuments — TanStack Query hook for the "Faturas recentes"
 * section on `/parties/:id`.
 *
 * Endpoint:
 *   GET /api/v1/parties/:id/documents?limit&from&to  → { items, meta }
 *
 * Shape mirrors `useDocuments` (the inbox) so the UI can reuse the
 * same row primitive. Only swallows 404 (party deleted between the
 * detail fetch and this one — legitimate race); 401 / 403 / 5xx all
 * surface so the UI shows the error banner and the auth-refresh
 * interceptor can act on a genuine session-dead 401.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { authedFetch } from '../../../_lib/auth-refresh';
import type { PartyDocument } from '../_lib/types';

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) ||
  'http://localhost:4000/api/v1';

export interface PartyDocumentsResponse {
  items: PartyDocument[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.message) detail = Array.isArray(data.message) ? data.message.join(': ') : data.message;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

export function usePartyDocuments(
  partyId: string | null,
  limit = 10,
): UseQueryResult<PartyDocumentsResponse> {
  return useQuery({
    enabled: Boolean(partyId),
    queryKey: ['party-documents', partyId, limit] as const,
    queryFn: async (): Promise<PartyDocumentsResponse> => {
      if (!partyId) {
        return { items: [], meta: { total: 0, page: 1, limit, totalPages: 0 } };
      }
      const sp = new URLSearchParams({ limit: String(limit) });
      const res = await authedFetch(`${API_BASE}/parties/${partyId}/documents?${sp}`);
      if (!res.ok) {
        // 404 = race condition (party deleted between detail fetch and
        // this one). Render an empty list silently — legitimate case.
        // Anything else (401 session-dead after refresh+retry, 403 RBAC,
        // 5xx server) must surface so the UI shows the error banner and
        // the auth interceptor can act on a genuine 401.
        if (res.status === 404) {
          return { items: [], meta: { total: 0, page: 1, limit, totalPages: 0 } };
        }
        let detail = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data?.message) detail = Array.isArray(data.message) ? data.message.join(': ') : data.message;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      return unwrap<PartyDocumentsResponse>(res);
    },
    staleTime: 30_000,
  });
}