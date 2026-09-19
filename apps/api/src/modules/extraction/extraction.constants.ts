import type { IbanCheckResult } from './extraction.service';

/**
 * BullMQ queue name for background document extraction. Worker +
 * producer share this constant so a typo can't desync them.
 */
export const EXTRACTION_QUEUE = 'extraction' as const;

export const EXTRACTION_QUEUE_OPTIONS = {
  jobName: 'extract-document',
  /** Soft timeout — worker is allowed to exceed briefly; BullMQ retries on hard cap. */
  attempts: 2,
  /** Backoff between retries when extraction fails (Tesseract crashes, etc.). */
  backoffMs: 2_000,
} as const;

/**
 * Payload pushed onto the extraction queue. Kept minimal — the worker
 * re-reads the Document from Prisma so we don't ship the binary inside
 * the job payload.
 */
export interface ExtractionJob {
  tenantId: string;
  userId: string | null;
  documentId: string;
  /** Optional pre-parsed QR payload — avoids re-OCR when the caller already has it. */
  qrText?: string;
  modelOverride?: string;
  providerOverride?: string;
  forceReextract?: boolean;
}

export interface ExtractionJobResult {
  queued: boolean;
  documentId: string;
  ok: boolean;
  reason?: string;
  source?: 'at_qr' | 'at_qr+ai' | 'ocr' | 'regex' | 'ai' | 'none';
  confidence?: number;
  ibanCheck?: IbanCheckResult;
  validation?: { ok: boolean; errors: string[]; warnings: string[] };
  fieldsPopulated?: string[];
  /**
   * When the post-extraction rename hook swapped the upload-time file
   * name for a `<SUPPLIER>_<DATE>_<NUMBER>` slug, this carries the new
   * slug for callers that want to surface it. Undefined when no rename
   * happened (no fields yet, or the slug already matched).
   */
  fileName?: string;
  document?: { id: string; status: string; fileName?: string };
  /**
   * Where the text fed into the regex/QR pipeline came from. Useful
   * for the operator UI to know if a doc needs manual OCR
   * (`needsManualOcr === true`) and how many pages were processed.
   */
  textSource?: 'pdf-text' | 'ocr' | 'none' | 'filename' | 'preloaded';
  needsManualOcr?: boolean;
  pageCount?: number;
  /**
   * When the AI supplied an SNC category AND a matching folder rule
   * fired, this is the new folder path the document was moved to.
   * Undefined when no auto-firing happened.
   */
  aiFiledFolder?: string;
  /**
   * The AI-suggested SNC/PGC category (Gap 2). Echoed back so the
   * controller / UI can show "filed under 62.2.4 — Honorários".
   */
  suggestedCategory?: string;
}
