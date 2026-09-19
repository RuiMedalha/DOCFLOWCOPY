-- Sprint 1.A — Review Screen com Confiança Visual.
--
-- Adds per-field extraction confidence columns to `documents`, two
-- structural validator flags (NIF mod-11, IBAN mod-97), and a new
-- `document_field_confirmations` table that records every operator
-- field-by-field confirmation as an immutable row.
--
-- Why nullable on every new column: the extraction service writes
-- these ONLY when the AI/vision provider returns a confidence hint
-- (Gemini does; regex/fallback paths leave them null and the UI
-- falls back to `ocrConfidence`). Legacy rows that pre-date the
-- migration stay NULL until the next re-extraction — preserving the
-- zero-downtime contract every other migration in this repo follows.
--
-- `document_field_confirmations` is append-only by convention (no
-- UPDATE/DELETE in service code). The composite index on
-- (tenantId, documentId, field) keeps the "latest confirmation per
-- field" lookup cheap; the (tenantId, confirmedAt) index feeds the
-- audit dashboard widget.
--
-- No data backfill: confidence columns default to NULL, validator
-- flags default to NULL, and `document_field_confirmations` is empty
-- for legacy rows.

-- ─── Per-field extraction confidence ─────────────────────────────────────
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "supplierNameConfidence"     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "supplierNifConfidence"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "supplierIbanConfidence"     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "supplierAddressConfidence"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "supplierCountryConfidence"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "totalAmountConfidence"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "issueDateConfidence"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "dueDateConfidence"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "categoryConfidence"         DOUBLE PRECISION;

-- ─── Structural validator flags (cheap mod-11 / mod-97 at write time) ───
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "nifValid"  BOOLEAN,
  ADD COLUMN IF NOT EXISTS "ibanValid" BOOLEAN;

-- ─── Append-only confirmation table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "document_field_confirmations" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "documentId"     TEXT NOT NULL,
  "field"          TEXT NOT NULL,
  "value"          TEXT NOT NULL,
  "previousValue"  TEXT,
  "confirmedById"  TEXT,
  "confirmedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "document_field_confirmations_tenantId_documentId_idx"
  ON "document_field_confirmations" ("tenantId", "documentId");

CREATE INDEX IF NOT EXISTS "document_field_confirmations_tenantId_documentId_field_idx"
  ON "document_field_confirmations" ("tenantId", "documentId", "field");

CREATE INDEX IF NOT EXISTS "document_field_confirmations_tenantId_confirmedAt_idx"
  ON "document_field_confirmations" ("tenantId", "confirmedAt");

-- Foreign key from confirmation → document with CASCADE so a
-- hard-deleted document also clears its confirmation trail. Matches
-- the convention used by `document_items` / `payment_events`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_field_confirmations_documentId_fkey'
  ) THEN
    ALTER TABLE "document_field_confirmations"
      ADD CONSTRAINT "document_field_confirmations_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE;
  END IF;
END$$;
