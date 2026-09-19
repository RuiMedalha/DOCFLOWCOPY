-- Sprint I+ — soft-delete (trash) on documents.
--
-- Adds a nullable `deletedAt` timestamp to `documents` so an operator
-- can archive a row without losing it (file + line items + payment
-- events + forensic chain) and restore it later through POST /:id/restore.
--
-- Soft-delete vs. ARQUIVADO: the legacy ARQUIVADO status coexists on
-- `documents.status` and is kept untouched here (status still drives the
-- downstream lifecycle — APPROVED / PROCESSED / etc.). `deletedAt` is
-- an orthogonal tombstone flag gated on the new `/documents/trash` listing
-- and explicit restore endpoint. The service layer keeps the two
-- disjoint: `findAll` hides both rows (ARQUIVADO + deletedAt != null);
-- the trash endpoint isolates the soft-deleted subset.
--
-- Composite index covers the trash listing and the per-tenant restore
-- lookup, both of which filter on (tenantId, deletedAt).

ALTER TABLE "documents"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "documents_tenantId_deletedAt_idx"
  ON "documents"("tenantId", "deletedAt");
