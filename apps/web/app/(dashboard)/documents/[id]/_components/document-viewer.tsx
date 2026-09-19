'use client';

/**
 * DocumentViewer — PDF / image preview pane for DocFlow documents.
 *
 * Editorial / Contábil · Blueprint Edition (commit 2026-09-04).
 *   - Frame navy 1px + gold inset top border (documento "dentro de uma capa
 *     editorial").
 *   - Toolbar: filename em Inter Tight 14px ink + badge em Fraunces 11px
 *     uppercase.
 *   - Body background em --ed-panel (paper-white) em vez de rgba(0,0,0,0.18).
 *
 * Three render modes:
 *   - application/pdf → <object>/<iframe> embed with the blob URL
 *   - image/*         → <img> with the blob URL
 *   - other           → fallback panel + download CTA
 *
 * Renders a skeleton while loading and an error card when the file can't be
 * fetched. Field highlights from the QR-AT decoder are mirrored as badge
 * overlays when present (PDF mode only).
 */

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { authedFetch } from '../../../../_lib/auth-refresh';

export interface DocumentViewerProps {
  /** Absolute URL to fetch the binary from (must include bearer token on server). */
  src: string;
  /** Optional filename shown in the download button. */
  fileName?: string;
  /** Optional MIME type — when omitted the viewer sniffs the response Content-Type. */
  mimeType?: string;
  /** Field codes from QR-AT that the viewer should highlight (PDF only, stub). */
  highlightFields?: string[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function pickIcon(mime?: string): 'pdf' | 'image' | 'file' {
  if (!mime) return 'file';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
}

export function DocumentViewer({ src, fileName = 'documento', mimeType, highlightFields = [] }: DocumentViewerProps) {
  const [state, setState] = useState<LoadState>('idle');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [resolvedType, setResolvedType] = useState<string | undefined>(mimeType);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!src) return;
    setState('loading');
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        // Use authedFetch so the bearer token is attached and a 401 triggers
        // a single token refresh+retry (same path as http.ts / api-client.ts).
        // The previous raw `fetch(src)` skipped auth, so the API returned 401
        // and the blob never loaded — the viewer rendered blank.
        const res = await authedFetch(src, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('Content-Type') ?? mimeType ?? 'application/octet-stream';
        setResolvedType(ct);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setState('ready');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setError((e as Error).message ?? 'Falha ao carregar');
        setState('error');
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [src, mimeType]);

  // Revoke blob URL on unmount or when src changes.
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const icon = pickIcon(resolvedType);

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        // Frame navy 1px + gold inset top border — "documento dentro de uma
        // capa editorial". O inset shadow desenha uma hairline gold no topo
        // sem precisar de :before pseudo-element.
        // Aspect ratio portrait (3/4) garante letterbox em vez de caixa
        // quadrada — antes era `min-h-[420px]` que esticava o viewer pra
        // ficar alto e narrow na coluna 4/12.
        aspectRatio: '3 / 4',
        maxWidth: '100%',
        background: 'var(--ed-panel)',
        border: '1px solid var(--ed-ink)',
        borderRadius: 'var(--ed-radius-card)',
        boxShadow: 'inset 0 1px 0 var(--ed-accent-gold)',
      }}
    >
      {/* Toolbar — altura fixa (não esticar) */}
      <header
        className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0"
        style={{
          height: '52px',
          background: 'var(--ed-canvas-2)',
          borderColor: 'var(--ed-rule)',
        }}
      >
        <span
          className="inline-flex items-center justify-center w-7 h-7"
          style={{
            background: 'var(--ed-canvas)',
            borderRadius: 'var(--ed-radius-chip)',
          }}
        >
          {icon === 'pdf' ? (
            <FileText size={14} aria-hidden="true" style={{ color: 'var(--ed-accent-gold-strong)' }} />
          ) : icon === 'image' ? (
            <ImageIcon size={14} aria-hidden="true" style={{ color: 'var(--ed-accent-gold-strong)' }} />
          ) : (
            <FileText size={14} aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
          )}
        </span>
        <span
          className="truncate flex-1"
          style={{
            fontFamily: 'var(--font-inter-tight), system-ui, sans-serif',
            fontSize: '14px',
            fontWeight: 500,
            color: 'var(--ed-ink)',
          }}
          title={fileName}
        >
          {fileName}
        </span>
        {highlightFields.length > 0 && (
          <span
            className="uppercase tracking-wider"
            style={{
              fontFamily: 'var(--font-editorial), ui-serif, Georgia, serif',
              fontSize: '11px',
              color: 'var(--ed-accent-gold-strong)',
              background: 'var(--ed-accent-gold-dim)',
              padding: '2px 8px',
              borderRadius: 'var(--ed-radius-chip)',
            }}
            title="Campos QR-AT detetados"
          >
            {highlightFields.length} campo{highlightFields.length === 1 ? '' : 's'} QR-AT
          </span>
        )}
        {blobUrl && (
          <>
            <a
              href={blobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-7 h-7 hover:opacity-70 transition-opacity"
              style={{
                color: 'var(--ed-ink-soft)',
                background: 'transparent',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Abrir numa nova janela"
            >
              <ExternalLink size={12} aria-hidden="true" />
            </a>
            <a
              href={blobUrl}
              download={fileName}
              className="inline-flex items-center justify-center w-7 h-7 hover:opacity-70 transition-opacity"
              style={{
                color: 'var(--ed-ink-soft)',
                background: 'transparent',
                borderRadius: 'var(--ed-radius-chip)',
              }}
              title="Transferir"
            >
              <Download size={12} aria-hidden="true" />
            </a>
          </>
        )}
      </header>

      {/* Body — fundo --ed-panel (paper-white) em vez de rgba(0,0,0,0.18) */}
      <div
        className="flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        style={{ background: 'var(--ed-panel)' }}
      >
        {state === 'loading' && (
          <div className="flex flex-col items-center gap-2 text-sm" style={{ color: 'var(--ed-ink-soft)' }}>
            <Loader2 size={22} className="animate-spin" aria-hidden="true" />
            A carregar documento…
          </div>
        )}

        {state === 'error' && (
          <div className="text-center max-w-xs px-6">
            <FileText size={28} className="mx-auto mb-2" aria-hidden="true" style={{ color: 'var(--ed-status-alert)' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--ed-ink)' }}>
              Não foi possível carregar o documento
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--ed-ink-soft)' }}>
              {error ?? 'Erro desconhecido'}
            </p>
          </div>
        )}

        {state === 'ready' && blobUrl && (
          <PdfOrImage blobUrl={blobUrl} mime={resolvedType} />
        )}

        {state === 'idle' && (
          <div className="flex flex-col items-center gap-2 text-sm" style={{ color: 'var(--ed-ink-faint)' }}>
            <FileText size={22} aria-hidden="true" />
            Sem documento
          </div>
        )}
      </div>
    </div>
  );
}

function PdfOrImage({ blobUrl, mime }: { blobUrl: string; mime?: string }) {
  if (mime?.includes('pdf')) {
    return (
      <iframe
        src={blobUrl}
        title="Pré-visualização do documento PDF"
        className="w-full h-full"
        style={{ border: 'none', minHeight: 0 }}
      />
    );
  }
  if (mime?.startsWith('image/')) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={blobUrl}
        alt="Pré-visualização do documento"
        className="max-w-full max-h-full object-contain"
      />
    );
  }
  return (
    <div className="text-center px-6">
      <FileText size={28} className="mx-auto mb-2" aria-hidden="true" style={{ color: 'var(--ed-ink-faint)' }} />
      <p className="text-sm font-medium" style={{ color: 'var(--ed-ink)' }}>
        Tipo de ficheiro sem pré-visualização
      </p>
      <p className="text-xs mt-1" style={{ color: 'var(--ed-ink-soft)' }}>
        Transfira o ficheiro para o abrir na aplicação nativa.
      </p>
    </div>
  );
}
