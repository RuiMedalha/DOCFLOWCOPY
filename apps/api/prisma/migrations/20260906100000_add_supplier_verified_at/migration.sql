-- Sprint H+ correct-supplier UX — add supplierVerifiedAt.
--
-- Marks when an operator reviewed the AI-extracted supplier block and
-- confirmed it as-is (no field edit). The "Confirmar como está" action
-- in the dialog calls PATCH /documents/:id/verify-supplier which writes
-- this timestamp; an audit row tagged `document.verify_supplier` is
-- emitted in the same transaction so the trail is replayable.
--
-- The column is nullable: rows predating the migration stay NULL until
-- the operator reviews them. The optional index keeps the "verified
-- docs last 7d" query (used by a follow-up backlog widget) cheap.

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "supplierVerifiedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "documents_tenantId_supplierVerifiedAt_idx"
  ON "documents" ("tenantId", "supplierVerifiedAt");
