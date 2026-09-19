'use client';

/**
 * DocFlow — authenticated HTTP helper for Wave 3 data modules.
 *
 * The existing `api-client.ts` covers the auth flow with an offline stub.
 * This helper is the generic bearer-token fetch used by every TanStack
 * Query hook (banking, crm, payments, settings). It unwraps the
 * `{ data: ... }` envelope the NestJS TransformInterceptor emits and
 * normalises errors into `HttpError`.
 *
 * On a 401, the request is retried exactly once after a token refresh.
 * The refresh is shared across concurrent 401s (single in-flight
 * promise) and the cookie mirror is updated through the auth store.
 */

import {
  API_BASE as REFRESH_API_BASE,
  getAccessToken,
  refreshSession,
} from './auth-refresh';

export const API_BASE = REFRESH_API_BASE;

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const token = getAccessToken();
  const headers = new Headers(extra);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function parseError(res: Response): Promise<HttpError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const body = await res.json();
    if (body?.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    if (body?.code) code = body.code;
  } catch {
    // ignore parse failure
  }
  return new HttpError(message, res.status, code);
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined | null;
}

function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Execute a request that may optionally attempt ONE refresh+retry on a 401.
 * `__retried` is set on the retry pass so we don't recurse forever.
 */
async function fetchWithAuthRetry(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status !== 401) return res;

  // Don't try to refresh on the refresh endpoint itself or on the login
  // endpoint — a 401 there means "bad credentials", not "expired token".
  if (path.endsWith('/auth/refresh') || path.endsWith('/auth/login')) {
    return res;
  }

  const hadToken = Boolean(getAccessToken());
  if (!hadToken) return res;

  const next = await refreshSession();
  if (!next) {
    // refreshSession() already cleared the session + redirected.
    return res;
  }

  // Rebuild the request with the fresh bearer token and retry once.
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${next.accessToken}`);
  return fetch(path, { ...init, headers });
}

export const http = {
  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const url = `${API_BASE}${path}${buildQuery(params)}`;
    const res = await fetchWithAuthRetry(url, {
      method: 'GET',
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return unwrap<T>(await res.json());
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchWithAuthRetry(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return unwrap<T>(await res.json());
  },

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchWithAuthRetry(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return unwrap<T>(await res.json());
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchWithAuthRetry(`${API_BASE}${path}`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return unwrap<T>(await res.json());
  },

  async del<T>(path: string): Promise<T> {
    const res = await fetchWithAuthRetry(`${API_BASE}${path}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return unwrap<T>(await res.json());
  },

  /** Fetch a text/csv or xml body for download flows. */
  async getBlob(path: string, params?: QueryParams): Promise<Blob> {
    const url = `${API_BASE}${path}${buildQuery(params)}`;
    const res = await fetchWithAuthRetry(url, {
      method: 'GET',
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },

  async postForBlob(path: string, body?: unknown): Promise<Blob> {
    const res = await fetchWithAuthRetry(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
};

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}