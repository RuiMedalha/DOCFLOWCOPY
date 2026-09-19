-- Sprint 1.B — Approval Workflow
--
-- Adds the approval state-machine to Document:
--   * New enum values PENDING_APPROVAL + CHANGES_REQUESTED on
--     `DocumentStatus`. The existing values stay in place for
--     legacy rows that pre-date the workflow.
--   * New enum `ApprovalStatus` (PENDING / APPROVED / REJECTED /
--     CHANGES_REQUESTED / WITHDRAWN).
--   * New table `approvals` holding every approval request —
--     append-only at the service layer (decisions mutate the row
--     in place; deletes never happen).
--   * Document.currentApprovalId — denormalised pointer to the
--     latest OPEN approval for this document, cleared on
--     decision. SetNull on delete so a hard-deleted document
--     also clears the pointer (the cascade on documentId handles
--     the approval rows themselves).
--   * User relations `approvalsRequested` + `approvalsDecided` —
--     no schema change to `users` table; these are inverse
--     relations declared on the Approval side only.
--
-- No data backfill: legacy rows keep their existing DocumentStatus
-- (NOVO/PROCESSADO/EM_REVISAO/APROVADO/REJEITADO/ARQUIVADO). The
-- workflow endpoints only act on rows in PENDING_APPROVAL.

-- ─── Enum additions ───────────────────────────────────────────────────────
ALTER TYPE "DocumentStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "DocumentStatus" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';

CREATE TYPE "ApprovalStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'WITHDRAWN'
);

-- ─── approvals table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "approvals" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "documentId"    TEXT NOT NULL,
  "status"        "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById" TEXT NOT NULL,
  "decidedById"   TEXT,
  "decidedAt"     TIMESTAMP(3),
  "comment"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "approvals_tenantId_status_idx"
  ON "approvals" ("tenantId", "status");

CREATE INDEX IF NOT EXISTS "approvals_tenantId_documentId_idx"
  ON "approvals" ("documentId");

CREATE INDEX IF NOT EXISTS "approvals_tenantId_requestedById_idx"
  ON "approvals" ("tenantId", "requestedById");

CREATE INDEX IF NOT EXISTS "approvals_tenantId_decidedById_idx"
  ON "approvals" ("tenantId", "decidedById");

CREATE INDEX IF NOT EXISTS "approvals_tenantId_createdAt_idx"
  ON "approvals" ("tenantId", "createdAt");

-- ─── documents.currentApprovalId ───────────────────────────────────────────
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "currentApprovalId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_currentApprovalId_fkey'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_currentApprovalId_fkey"
      FOREIGN KEY ("currentApprovalId") REFERENCES "approvals"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- ─── approval FKs to users ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_requestedById_fkey'
  ) THEN
    ALTER TABLE "approvals"
      ADD CONSTRAINT "approvals_requestedById_fkey"
      FOREIGN KEY ("requestedById") REFERENCES "users"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_decidedById_fkey'
  ) THEN
    ALTER TABLE "approvals"
      ADD CONSTRAINT "approvals_decidedById_fkey"
      FOREIGN KEY ("decidedById") REFERENCES "users"("id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_documentId_fkey'
  ) THEN
    ALTER TABLE "approvals"
      ADD CONSTRAINT "approvals_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE;
  END IF;
END$$;
