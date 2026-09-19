'use client';

/**
 * DocFlow — Storage browser page.
 *
 * Sprint H+ fix-up: the user reported "também não está a gravar nos
 * fornecedores nem aparece para colocar em pasta". The backend folder
 * routing has been live since Sprint E (documents.service.ts →
 * `relocateAfterApprove()`), but there was NO UI page to navigate the
 * resulting folder tree. This page renders a tree-view of
 * `<uploadsRoot>/<tenantId>/...` via `GET /storage/tree`.
 *
 * UX choices:
 *   - Breadcrumb at the top — click any segment to jump.
 *   - Folders first, sorted alphabetically.
 *   - Files are clickable — they open the inbox search pre-filtered on
 *     that filename, since files are mapped 1:1 to a document via the
 *     fileName + sha256 stored at upload time. Direct file download by
 *     key is gated behind a future "Signed URL" Sprint H deliverable.
 *   - "Voltar" button when not at the root.
 *   - Empty state with a hint ("Nenhum ficheiro aqui — faça upload").
 *
 * Auth: every call goes through `authedFetch`, which attaches the bearer
 * token. tenantId is server-side only.
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  AlertTriangle,
  Upload,
} from 'lucide-react';
import { PageHeader } from '../_components/page-header';
import { useStorageTree, type FsEntry } from './_lib/use-storage-tree';

function formatBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function StoragePage() {
  const router = useRouter();

  // Path is held in the URL so it survives refresh and is shareable.
  // Default = `/` (tenant root).
  const path =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('path') || '/'
      : '/';

  const tree = useStorageTree(path);

  const navigateTo = useCallback(
    (next: string) => {
      const sp = new URLSearchParams();
      if (next && next !== '/') sp.set('path', next);
      router.push(`/storage${sp.toString() ? `?${sp.toString()}` : ''}`);
    },
    [router],
  );

  const onFileClick = useCallback(
    (file: FsEntry) => {
      // We don't have a file→docId lookup endpoint yet. The pragmatic
      // MVP UX is: route to the inbox with the filename pre-filled
      // in the search so the user can find the document that owns
      // this file. Filename matches the original upload name.
      const sp = new URLSearchParams();
      sp.set('search', file.name);
      router.push(`/documents?${sp.toString()}`);
    },
    [router],
  );

  const crumbs = pathToBreadcrumbs(path);

  return (
    <div>
      <PageHeader
        title="Armazenamento"
        subtitle="Navegue pelas pastas do seu tenant — _inbox, fornecedores/, clientes/, despesas/."
        actions={
          <button
            type="button"
            onClick={() => router.push('/documents')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: 'var(--accent)',
              color: '#0b1220',
            }}
            aria-label="Subir novo documento"
          >
            <Upload size={14} />
            Subir documento
          </button>
        }
      />

      {/* Breadcrumb */}
      <nav
        aria-label="Caminho"
        className="card px-4 py-3 mb-4 flex items-center gap-1.5 flex-wrap text-sm"
      >
        <button
          type="button"
          onClick={() => navigateTo('/')}
          className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-[var(--hover)]"
          aria-label="Voltar à raiz"
        >
          <Home size={14} style={{ color: 'var(--text-subtle)' }} />
          <span style={{ color: 'var(--text-subtle)' }}>tenant</span>
        </button>
        {crumbs.map((c, i) => (
          <span key={`${c.path}-${i}`} className="inline-flex items-center gap-1.5">
            <ChevronRight size={12} style={{ color: 'var(--text-subtle)' }} />
            <button
              type="button"
              onClick={() => navigateTo(c.path)}
              className="px-1.5 py-0.5 rounded hover:bg-[var(--hover)]"
              style={{
                color: i === crumbs.length - 1 ? 'var(--text)' : 'var(--text-subtle)',
                fontWeight: i === crumbs.length - 1 ? 500 : 400,
              }}
              aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {/* Tree content */}
      {tree.isPending ? (
        <div
          className="card p-8 text-center"
          style={{ color: 'var(--text-subtle)' }}
        >
          <Loader2 size={20} className="inline animate-spin mr-2" />
          A carregar…
        </div>
      ) : tree.isError ? (
        <div
          className="card p-6 flex items-center gap-3"
          style={{
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.25)',
          }}
          role="alert"
        >
          <AlertTriangle size={18} style={{ color: 'var(--danger)' }} />
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
              Erro a carregar a árvore de pastas
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-subtle)' }}>
              {tree.error instanceof Error ? tree.error.message : 'Erro desconhecido'}
            </p>
          </div>
        </div>
      ) : (
        <TreeView
          folders={tree.data!.folders}
          files={tree.data!.files}
          parent={tree.data!.parent}
          onFolderClick={navigateTo}
          onFileClick={onFileClick}
        />
      )}
    </div>
  );
}

function TreeView({
  folders,
  files,
  parent,
  onFolderClick,
  onFileClick,
}: {
  folders: FsEntry[];
  files: FsEntry[];
  parent: string | null;
  onFolderClick: (path: string) => void;
  onFileClick: (file: FsEntry) => void;
}) {
  const isEmpty = folders.length === 0 && files.length === 0;
  return (
    <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
      {parent !== null && parent !== '/' && (
        <button
          type="button"
          onClick={() => onFolderClick(parent)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
          aria-label="Voltar ao diretório anterior"
        >
          <ArrowLeft size={16} style={{ color: 'var(--text-subtle)' }} />
          <span className="text-sm" style={{ color: 'var(--text-subtle)' }}>
            ..
          </span>
        </button>
      )}

      {folders.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => onFolderClick(f.path)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
          aria-label={`Abrir pasta ${f.name}`}
        >
          <Folder size={16} style={{ color: 'var(--accent)' }} aria-hidden="true" />
          <span className="text-sm flex-1 truncate" style={{ color: 'var(--text)' }}>
            {f.name}
          </span>
          <FolderOpen size={14} style={{ color: 'var(--text-subtle)' }} aria-hidden="true" />
        </button>
      ))}

      {files.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => onFileClick(f)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
          aria-label={`Procurar ${f.name} na inbox`}
        >
          <FileText size={16} style={{ color: 'var(--text-subtle)' }} aria-hidden="true" />
          <span className="text-sm flex-1 truncate" style={{ color: 'var(--text)' }}>
            {f.name}
          </span>
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-subtle)' }}>
            {formatBytes(f.size)}
          </span>
        </button>
      ))}

      {isEmpty && (
        <div
          className="px-4 py-10 text-center text-sm"
          style={{ color: 'var(--text-subtle)' }}
        >
          Pasta vazia. Faça upload de documentos para os ver aqui.
        </div>
      )}
    </div>
  );
}

interface Crumb {
  path: string;
  label: string;
}

function pathToBreadcrumbs(p: string): Crumb[] {
  if (!p || p === '/') return [];
  const segs = p.replace(/^\/+/, '').split('/').filter((s) => s.length > 0);
  const out: Crumb[] = [];
  let acc = '';
  for (const s of segs) {
    acc += '/' + s;
    out.push({ path: acc, label: s });
  }
  return out;
}
