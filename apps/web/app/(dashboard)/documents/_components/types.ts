/**
 * DocFlow — Document Inbox types.
 *
 * Mirrors the contract exposed by the backend `documents` module
 * (responses wrapped as `{ data: ... }` by TransformInterceptor).
 *
 * Fase 4.1 — este ficheiro estava a declarar um contrato que a API nunca
 * teve: `nif`, `documentDate`, `iva` e enums em minúsculas. A API devolve
 * os nomes das colunas Prisma (`supplierNif`, `docDate`, `taxAmount`) e os
 * enums em MAIÚSCULAS. Resultado no teste real do Rui: as colunas NIF e
 * Data vinham vazias em todos os registos e o estado não aparecia. Os
 * nomes abaixo são agora os que a API devolve mesmo — verificado contra
 * `GET /documents` em produção.
 */

/** Prisma `DocumentStatus`. */
export type DocumentStatus =
  | 'NOVO'
  | 'PROCESSADO'
  | 'EM_REVISAO'
  | 'APROVADO'
  | 'REJEITADO'
  | 'ARQUIVADO'
  | 'PENDING_APPROVAL'
  | 'CHANGES_REQUESTED'
  | 'DUPLICADO';

/** Fase 3 — validade fiscal determinística (backend `FiscalStatus`). */
export type FiscalStatus = 'FISCAL' | 'NAO_FISCAL' | 'INDETERMINADO' | 'NAO_APLICAVEL';

/** Prisma `DocumentType`. */
export type DocumentType =
  | 'FATURA_RECEBIDA'
  | 'FATURA_EMITIDA'
  | 'RECIBO'
  | 'COMPROVATIVO'
  | 'NOTA_CREDITO'
  | 'NOTA_DEBITO'
  | 'ENCOMENDA'
  | 'GUIA_TRANSPORTE'
  | 'OUTRO'
  | 'PROFORMA'
  | 'ORCAMENTO'
  | 'AVISO_PAGAMENTO'
  | 'EXTRATO_FORNECEDOR'
  | 'FATURA_SIMPLIFICADA';

/**
 * Mirrors the backend Prisma `DocumentOrigin` enum (Sprint F extended
 * with GMAIL / OUTLOOK / INBOUND_WEBHOOK / ONEDRIVE). `EMAIL` is retained for
 * backwards compatibility with rows ingested via the legacy IMAP path.
 */
export type DocumentOrigin =
  | 'UPLOAD'
  | 'EMAIL'
  | 'SCANNER'
  | 'MOBILE'
  | 'WHATSAPP'
  | 'API'
  | 'GMAIL'
  | 'OUTLOOK'
  | 'INBOUND_WEBHOOK'
  | 'ONEDRIVE';

export interface DocumentFolder {
  id: string;
  name: string;
  color?: string | null;
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  status: DocumentStatus;
  type: DocumentType;
  origin?: DocumentOrigin | null;
  supplier?: string | null;
  /** NIF do emitente. Só está preenchido quando passou módulo 11 / VIES. */
  supplierNif?: string | null;
  /** Código ATCUD. Só existe em documentos portugueses certificados. */
  atcud?: string | null;
  /** Data de emissão (ISO). */
  docDate?: string | null;
  docNumber?: string | null;
  total?: number | null;
  /** IVA do documento (coluna `taxAmount`). */
  taxAmount?: number | null;
  netAmount?: number | null;
  currency?: string | null;
  folder?: DocumentFolder | null;
  tags?: string[];
  rank?: number | null;
  createdAt: string;
  fiscalStatus?: FiscalStatus | null;
  fiscalReason?: string | null;
  duplicateOfId?: string | null;
  metadata?: Record<string, any> | null;
}

export interface DocumentListResponse {
  items: DocumentRecord[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface DocumentFiltersState {
  search: string;
  status: '' | DocumentStatus;
  type: '' | DocumentType;
  excludeType?: '' | DocumentType;
  fiscalStatus: '' | FiscalStatus;
  dateFrom: string;
  dateTo: string;
  origin?: DocumentOrigin[];
}

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  NOVO: 'Novo',
  PROCESSADO: 'Processado',
  EM_REVISAO: 'Em revisão',
  APROVADO: 'Aprovado',
  REJEITADO: 'Rejeitado',
  ARQUIVADO: 'Arquivado',
  PENDING_APPROVAL: 'Por aprovar',
  CHANGES_REQUESTED: 'Correções pedidas',
  DUPLICADO: 'Duplicado',
};

export const FISCAL_STATUS_LABEL: Record<FiscalStatus, string> = {
  FISCAL: 'Fiscal',
  NAO_FISCAL: 'Não fiscal',
  INDETERMINADO: 'Por confirmar',
  NAO_APLICAVEL: 'Encomenda cliente',
};

export const FISCAL_STATUS_BADGE: Record<FiscalStatus, string> = {
  FISCAL: 'badge-emerald',
  NAO_FISCAL: 'badge-rose',
  INDETERMINADO: 'badge-amber',
  NAO_APLICAVEL: 'badge-violet',
};

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  FATURA_RECEBIDA: 'Fatura',
  FATURA_EMITIDA: 'Fatura emitida',
  RECIBO: 'Recibo',
  COMPROVATIVO: 'Comprovativo',
  NOTA_CREDITO: 'Nota de crédito',
  NOTA_DEBITO: 'Nota de débito',
  ENCOMENDA: 'Nota de encomenda',
  GUIA_TRANSPORTE: 'Guia de transporte',
  OUTRO: 'Outro',
  PROFORMA: 'Proforma',
  ORCAMENTO: 'Orçamento',
  AVISO_PAGAMENTO: 'Aviso de pagamento',
  EXTRATO_FORNECEDOR: 'Extrato de conta',
  FATURA_SIMPLIFICADA: 'Fatura simplificada',
};
