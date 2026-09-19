-- Sprint H — DocumentProcessingStatus pipeline.
-- Without this migration a fresh `prisma migrate deploy` would fail
-- because the Prisma schema references `DocumentProcessingStatus`
-- and the five columns on `documents` but the DB has no enum / cols.
--
-- Idempotent: enum + column guard each step with `IF NOT EXISTS` so
-- re-running against a partially-applied DB is safe.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentProcessingStatus') THEN
    CREATE TYPE "DocumentProcessingStatus" AS ENUM (
      'RECEIVED',
      'EXTRACTING',
      'ENRICHING',
      'ROUTING',
      'COMPLETED',
      'FAILED'
    );
  END IF;
END $$;

-- AlterTable — add columns only if missing.
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "processingStatus" "DocumentProcessingStatus",
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingError" TEXT,
  -- Sprint H security-audit H-2: schema declares `processingAttempt
  -- Int @default(0)` but the original migration omitted this column.
  -- Without the column, `prisma generate` types the field happily
  -- and the runtime error only appears on first read/write. Add it
  -- here so fresh `prisma migrate deploy` produces a usable DB.
  ADD COLUMN IF NOT EXISTS "processingAttempt" INTEGER NOT NULL DEFAULT 0;

-- Index — speeds up SSE pollers / status filters by tenant + status.
CREATE INDEX IF NOT EXISTS "documents_tenantId_processingStatus_idx"
  ON "documents" ("tenantId", "processingStatus");
