'use client';

/**
 * DocFlow — UploadZone.
 *
 * Drag-and-drop area backed by `react-dropzone`. Multi-file, with
 * per-file progress events. Duplicates (API 409 with `existingId`) are
 * surfaced as an INFORMATIONAL outcome — friendly copy + a button that
 * opens the original document — not as an error.
 */

import { useDropzone } from 'react-dropzone';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Info,
  X,
  ExternalLink,
  Camera,
  FolderUp,
} from 'lucide-react';
import { useUploadDocuments, type UploadProgressEvent } from './use-documents';

interface UploadItem {
  fileName: string;
  progress: number;
  status: 'uploading' | 'done' | 'duplicate' | 'error';
  message?: string;
  existingId?: string;
  existingFileName?: string;
}

export function UploadZone() {
  const upload = useUploadDocuments();
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  // Hidden file input for the camera-capture path. We can't reuse
  // `getInputProps` from react-dropzone because react-dropzone
  // intentionally strips `capture` to keep the contract neutral —
  // we need our own input here so iOS Safari / Android Chrome will
  // open the rear camera directly.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onProgress = useCallback((evt: UploadProgressEvent) => {
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.fileName === evt.fileName);
      const next: UploadItem = {
        fileName: evt.fileName,
        progress: evt.progress,
        status: evt.status,
        message: evt.message,
        existingId: evt.existingId,
        existingFileName: evt.existingFileName,
      };
      if (idx === -1) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const startUpload = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setItems((prev) => [
        ...prev.filter((p) => p.status === 'uploading'),
        ...files.map((f) => ({ fileName: f.name, progress: 0, status: 'uploading' as const })),
      ]);
      upload.mutate({ files, onProgress });
    },
    [upload, onProgress],
  );

  const onDrop = useCallback(
    (accepted: File[]) => {
      startUpload(accepted);
    },
    [startUpload],
  );

  const onCameraCapture = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      // Reset the input so picking the same file twice fires `change`
      // again (mobile browsers cache the FileList otherwise).
      e.target.value = '';
      startUpload(files);
    },
    [startUpload],
  );

  const onFilePicker = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      startUpload(files);
    },
    [startUpload],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    multiple: true,
    accept: {
      'application/pdf': ['.pdf'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'image/webp': ['.webp'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxSize: 20 * 1024 * 1024,
  });

  // Auto-clear finished items after a delay so the list doesn't pile up.
  useEffect(() => {
    const timer = setInterval(() => {
      setItems((prev) => prev.filter((i) => i.status === 'uploading'));
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const removeItem = (fileName: string) => {
    setItems((prev) => prev.filter((i) => i.fileName !== fileName));
  };

  const openExisting = (id: string) => {
    router.push(`/documents/${id}`);
  };

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={`card p-8 md:p-10 text-center cursor-pointer transition-all duration-300 animate-in ${
          isDragActive ? 'scale-[1.01]' : ''
        } ${isDragReject ? 'opacity-60' : ''}`}
        style={{
          borderStyle: 'dashed',
          borderWidth: 2,
          borderColor: isDragActive ? 'rgba(56,189,248,0.5)' : 'var(--border-strong)',
          boxShadow: isDragActive ? '0 0 40px rgba(56,189,248,0.18)' : 'none',
        }}
      >
        <input {...getInputProps()} />
        <div
          className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(129,140,248,0.10))',
            border: '1px solid rgba(56,189,248,0.25)',
          }}
        >
          <UploadCloud className="text-sky-400" size={24} />
        </div>
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {isDragActive ? 'Largue os ficheiros para enviar' : 'Arraste ficheiros ou clique para selecionar'}
        </p>
        <p className="text-xs mt-1.5" style={{ color: 'var(--text-subtle)' }}>
          PDF, JPG, PNG, WEBP, DOCX · até 20 MB por ficheiro · multi-ficheiro
        </p>
      </div>

      {/*
        Camera capture path. Two distinct actions:
        - "Tirar foto" → mobile opens the rear camera (capture="environment"),
          desktop opens the system camera picker.
        - "Escolher ficheiro" → same file picker as the dropzone, for users
          who want explicit control without drag-and-drop.

        We render the hidden input once and click() it programmatically so
        both buttons reuse a single DOM node — and reset its value on
        change (see onCameraCapture) so the same file can be re-picked.
      */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        // The single most important attribute for the user's complaint:
        // on iOS Safari this opens the rear camera directly instead of
        // the photo library. On desktop with no camera, the OS falls back
        // to a normal file picker (image MIME filter still applies).
        capture="environment"
        onChange={onCameraCapture}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      {/*
        Plain file picker — NO capture attribute, so on mobile this opens
        the photo library / Files app instead of the camera. Desktop gets
        a normal file picker.
      */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        multiple
        onChange={onFilePicker}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          style={{
            background: 'linear-gradient(135deg, rgba(56,189,248,0.18), rgba(129,140,248,0.12))',
            border: '1px solid rgba(56,189,248,0.35)',
            color: 'var(--text)',
          }}
          aria-label="Tirar foto com a câmara"
        >
          <Camera size={16} className="text-sky-400" />
          📷 Tirar foto
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          style={{
            background: 'var(--hover)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text)',
          }}
          aria-label="Selecionar ficheiro do dispositivo"
        >
          <FolderUp size={16} style={{ color: 'var(--text-subtle)' }} />
          📁 Escolher ficheiro
        </button>
      </div>

      {items.filter((i) => i.status === 'uploading').length > 0 && (
        <div className="card p-3 space-y-2">
          {items
            .filter((i) => i.status === 'uploading')
            .map((it) => (
              <UploadRow key={it.fileName} item={it} />
            ))}
        </div>
      )}

      {items.some((i) => i.status === 'duplicate') && (
        <div className="space-y-1.5">
          {items
            .filter((i) => i.status === 'duplicate')
            .map((it) => (
              <DuplicateRow
                key={it.fileName}
                item={it}
                onOpenExisting={openExisting}
                onDismiss={() => removeItem(it.fileName)}
              />
            ))}
        </div>
      )}

      {items.some((i) => i.status === 'done') && (
        <div className="space-y-1.5">
          {items
            .filter((i) => i.status === 'done')
            .slice(-5)
            .map((it) => (
              <UploadRow key={it.fileName} item={it} onDismiss={() => removeItem(it.fileName)} />
            ))}
        </div>
      )}

      {items.some((i) => i.status === 'error') && (
        <div className="space-y-1.5">
          {items
            .filter((i) => i.status === 'error')
            .map((it) => (
              <UploadRow key={it.fileName} item={it} onDismiss={() => removeItem(it.fileName)} />
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Friendly duplicate row — NOT styled as an error. 409 dedup is an
 * informational outcome: the file already exists, here it is.
 */
function DuplicateRow({
  item,
  onOpenExisting,
  onDismiss,
}: {
  item: UploadItem;
  onOpenExisting: (id: string) => void;
  onDismiss?: () => void;
}) {
  const originalName = item.existingFileName ?? item.fileName;
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
      style={{
        background: 'rgba(56,189,248,0.06)',
        border: '1px solid rgba(56,189,248,0.25)',
      }}
      role="status"
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: 'rgba(56,189,248,0.12)',
          border: '1px solid rgba(56,189,248,0.25)',
        }}
      >
        <Info size={16} style={{ color: 'var(--accent)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
          {item.message ?? 'Este documento já foi carregado'}
        </p>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-subtle)' }}>
          Já existe na sua inbox como <span className="font-medium">{originalName}</span>.
        </p>
      </div>
      {item.existingId && (
        <button
          type="button"
          onClick={() => onOpenExisting(item.existingId!)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{
            background: 'var(--accent)',
            color: '#0b1220',
          }}
          aria-label={`Abrir documento existente ${originalName}`}
        >
          <ExternalLink size={12} />
          Abrir documento existente
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 rounded-md hover:bg-[var(--hover)]"
          aria-label={`Dispensar ${item.fileName}`}
        >
          <X size={14} style={{ color: 'var(--text-subtle)' }} />
        </button>
      )}
    </div>
  );
}

function UploadRow({ item, onDismiss }: { item: UploadItem; onDismiss?: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
      style={{ background: 'var(--hover)', border: '1px solid var(--border)' }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: 'rgba(56,189,248,0.10)',
          border: '1px solid rgba(56,189,248,0.20)',
        }}
      >
        {item.status === 'done' ? (
          <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
        ) : item.status === 'duplicate' ? (
          <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
        ) : item.status === 'error' ? (
          <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
        ) : (
          <FileText size={16} style={{ color: 'var(--accent)' }} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
            {item.fileName}
          </span>
          <span className="text-xs tabular-nums flex-shrink-0" style={{ color: 'var(--text-subtle)' }}>
            {item.progress}%
          </span>
        </div>
        <div
          className="h-1.5 mt-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--border-strong)' }}
        >
          <div
            className="h-full transition-all duration-200"
            style={{
              width: `${item.progress}%`,
              background:
                item.status === 'error'
                  ? 'var(--danger)'
                  : item.status === 'duplicate'
                    ? 'var(--warning)'
                    : 'linear-gradient(90deg, var(--accent), var(--accent-2))',
            }}
          />
        </div>
        {item.message && (
          <p
            className="text-xs mt-1"
            style={{
              color:
                item.status === 'error'
                  ? 'var(--danger)'
                  : item.status === 'duplicate'
                    ? 'var(--warning)'
                    : 'var(--text-muted)',
            }}
          >
            {item.message}
          </p>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 rounded-md hover:bg-[var(--hover)]"
          aria-label={`Remover ${item.fileName}`}
        >
          <X size={14} style={{ color: 'var(--text-subtle)' }} />
        </button>
      )}
    </div>
  );
}
