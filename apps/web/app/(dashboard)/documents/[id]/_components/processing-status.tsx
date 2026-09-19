'use client';

/**
 * ProcessingStatus — client component that subscribes to the SSE
 * pipeline stream and renders a live status badge + stage progress.
 *
 * SECURITY (Sprint H review-finding B-3 / H-3):
 *   - Native `EventSource` cannot set `Authorization: Bearer` headers,
 *     so we send the JWT via the `?token=` query-param fallback that
 *     the backend accepts.
 *   - If SSE returns 401/403/404/5xx we fall back to a polling loop
 *     against the regular authenticated endpoint — `fetchStatus()`
 *     uses `authedFetch` which DOES carry the bearer header.
 *   - On unmount we MUST call `eventSource.close()` so the backend
 *     releases the per-doc connection slot (and stops counting toward
 *     the 5-connection cap).
 *
 * XSS — the backend's `processingError` is rendered as a text node,
 * never via dangerouslySetInnerHTML. React auto-escapes text content,
 * so even an unsanitised error string cannot inject markup.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { authedFetch } from '../../../../_lib/auth-refresh';
import { useAuthStore } from '../../../../_lib/auth-store';

export interface ProcessingStatusProps {
  /** Document id whose pipeline we're tracking. */
  documentId: string;
  /**
   * If true, the parent already knows the pipeline is complete and
   * we should not open a stream — just render the terminal state.
   */
  initialStatus?: ProcessingStage | null;
}

export interface ProcessingStage {
  stage: 'RECEIVED' | 'EXTRACTING' | 'ENRICHING' | 'ROUTING' | 'COMPLETED' | 'FAILED';
  status: 'started' | 'completed' | 'failed';
  completedAt: string;
  approved?: boolean;
  error?: string;
  replay?: boolean;
  /** Free-form key/value bag forwarded from the SSE event payload. */
  [key: string]: unknown;
}

const SSE_POLL_TIMEOUT_MS = 3_000;
const FALLBACK_POLL_INTERVAL_MS = 4_000;

const STAGE_ORDER: ProcessingStage['stage'][] = [
  'RECEIVED',
  'EXTRACTING',
  'ENRICHING',
  'ROUTING',
  'COMPLETED',
];


// Sprint I — friendly labels for each pipeline stage.
const STAGE_LABEL: Record<string, string> = {
  RECEIVED: 'A aguardar início',
  EXTRACTING: 'A extrair dados do documento',
  ENRICHING: 'A enriquecer dados externos (Sabi PT / VIES)',
  ROUTING: 'A arquivar e rotear',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
};
export function ProcessingStatus({
  documentId,
  initialStatus,
}: ProcessingStatusProps): React.ReactElement {
  const accessToken = useAuthStore((s: { accessToken: string | null }) => s.accessToken);
  const [stage, setStage] = useState<ProcessingStage | null>(
    initialStatus ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // ─────────────────────────────────────────── SSE ─────────────────

  useEffect(() => {
    if (!documentId) return;
    if (stage?.stage === 'COMPLETED' || stage?.stage === 'FAILED') {
      // Already terminal — no need to subscribe.
      return;
    }

    let cancelled = false;
    let fellBackToPolling = false;
    let receivedSseEvent = false;
    let sseWatchdog: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (sseWatchdog) clearTimeout(sseWatchdog);
      if (pollTimer) clearInterval(pollTimer);
    };

    // Open the SSE stream. The JWT travels as ?token= because the
    // browser EventSource cannot set custom headers (H-3).
    const tokenParam = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
    const url = `/api/v1/documents/${encodeURIComponent(documentId)}/processing/stream${tokenParam}`;

    let es: EventSource;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch (err) {
      // EventSource throws synchronously on a malformed URL — unlikely
      // here but worth handling defensively.
      setError(err instanceof Error ? err.message : String(err));
      startFallback();
      return cleanup;
    }
    eventSourceRef.current = es;

    // 3-second watchdog: if SSE hasn't delivered ANY event by then
    // (including a keepalive comment), assume the auth path failed
    // (401 from missing token) and fall back to polling.
    sseWatchdog = setTimeout(() => {
      if (cancelled) return;
      if (!fellBackToPolling && !receivedSseEvent) {
        // No event yet — fall back to polling.
        startFallback();
      }
    }, SSE_POLL_TIMEOUT_MS);

    es.addEventListener('error', () => {
      // EventSource doesn't expose a status code; assume auth failure
      // or transient disconnect and fall back to polling.
      if (cancelled) return;
      startFallback();
    });

    // Subscribe to the named events we care about. EventSource uses
    // `message` for untyped events; here the backend names the type
    // so we listen by name.
    const handleStage = (evt: MessageEvent): void => {
      try {
        const parsed = JSON.parse(evt.data) as { payload?: ProcessingStage };
        if (parsed.payload) {
          receivedSseEvent = true;
          if (sseWatchdog) clearTimeout(sseWatchdog);
          setStage(parsed.payload);
          if (parsed.payload.stage === 'COMPLETED' || parsed.payload.stage === 'FAILED') {
            // Terminal — close the stream so the server releases the slot.
            es.close();
            stopPolling();
          }
        }
      } catch {
        // ignore malformed payload
      }
    };
    es.addEventListener('processing.stage.completed', handleStage);
    es.addEventListener('processing.completed', handleStage);
    es.addEventListener('processing.failed', handleStage);

    function startFallback(): void {
      if (fellBackToPolling || cancelled) return;
      fellBackToPolling = true;
      setUsingFallback(true);
      // Close the SSE stream — the server already counted it; closing
      // releases the per-doc slot.
      try {
        es.close();
      } catch {
        // ignore
      }
      if (sseWatchdog) clearTimeout(sseWatchdog);
      pollTimer = setInterval(async () => {
        if (cancelled) return;
        try {
          await fetchStatus();
        } catch {
          // ignored — next tick will retry
        }
      }, FALLBACK_POLL_INTERVAL_MS);
    }

    function stopPolling(): void {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    async function fetchStatus(): Promise<void> {
      const res = await authedFetch(
        `/documents/${encodeURIComponent(documentId)}`,
      );
      if (!res.ok) {
        // Surface 401/403 in the error slot but keep polling.
        if (res.status === 401 || res.status === 403) {
          setError('Sessão expirada — a atualizar estado em background.');
        }
        return;
      }
      const envelope = (await res.json()) as {
        data?: { processingStatus?: string; processingError?: string | null };
        processingStatus?: string;
        processingError?: string | null;
      };
      const document = envelope.data ?? envelope;
      if (document.processingStatus) {
        const nextStage = document.processingStatus as ProcessingStage['stage'];
        setStage({
          stage: nextStage,
          status: nextStage === 'FAILED' ? 'failed' : nextStage === 'COMPLETED' ? 'completed' : 'started',
          completedAt: new Date().toISOString(),
          error: document.processingError ?? undefined,
        });
        if (nextStage === 'COMPLETED' || nextStage === 'FAILED') {
          stopPolling();
        }
      }
    }

    return cleanup;
    // We deliberately exclude `stage` from the deps: re-subscribing on
    // every state update would open+close streams rapidly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, accessToken]);

  // ─────────────────────────────────────────── view ─────────────────

  const view = renderView(stage, usingFallback, error);
  return view;
}

function renderView(
  stage: ProcessingStage | null,
  usingFallback: boolean,
  error: string | null,
): React.ReactElement {
  if (error && !stage) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4" />
        <span>Estado do pipeline indisponível: {error}</span>
      </div>
    );
  }

  if (!stage) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>A aguardar início do pipeline…</span>
      </div>
    );
  }

  if (stage.stage === 'FAILED') {
    // XSS safe: rendered as text. The backend caps processingError at
    // 500 chars; we slice further to keep the UI tidy.
    const errMsg =
      typeof stage.error === 'string' ? stage.error.slice(0, 80) : 'Falha desconhecida';
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
        <XCircle className="h-4 w-4" />
        <span>Falhou no estágio {stage.stage}: {errMsg}</span>
        {usingFallback && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-red-500">
            <RefreshCw className="h-3 w-3 animate-spin" />
            polling
          </span>
        )}
      </div>
    );
  }

  if (stage.stage === 'COMPLETED') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        <CheckCircle2 className="h-4 w-4" />
        <span>Pipeline concluído{stage.approved ? ' (auto-aprovado)' : ''}</span>
        {usingFallback && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-600">
            <RefreshCw className="h-3 w-3 animate-spin" />
            polling
          </span>
        )}
      </div>
    );
  }

  // In-progress: show a small progress bar of completed stages.
  const idx = STAGE_ORDER.indexOf(stage.stage);
  const total = STAGE_ORDER.length - 1; // COMPLETED is the goal, not a step
  const completed = Math.max(0, Math.min(idx, total));

  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-slate-700">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>A processar — {STAGE_LABEL[stage.stage] ?? stage.stage}</span>
        {usingFallback && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500">
            <RefreshCw className="h-3 w-3 animate-spin" />
            polling
          </span>
        )}
      </div>
      <div className="flex gap-1" aria-label="pipeline progress">
        {STAGE_ORDER.slice(0, -1).map((s, i) => (
          <div
            key={s}
            className={
              'h-1 flex-1 rounded ' +
              (i < completed
                ? 'bg-emerald-500'
                : i === completed
                  ? 'bg-amber-400'
                  : 'bg-slate-200')
            }
            title={s}
          />
        ))}
      </div>
    </div>
  );
}
