-- Sprint I — Party enrichment metadata columns.
--
-- Adds the three nullable columns EnrichmentService writes to the
-- Party row whenever the Sabi PT / VIES / manual provider chain runs.
--
--   enrichedAt         DateTime? — last successful enrichment timestamp
--                                  (gates the 30-day TTL gate)
--   enrichmentSource   String?  — 'sabi-pt' | 'vies' | 'manual' | 'ai-extract'
--   enrichmentError    String?  — last failure reason for the badge
--
-- Idempotent so re-running against a partially-applied DB is safe.

ALTER TABLE "parties"
  ADD COLUMN IF NOT EXISTS "enrichedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "enrichmentSource" TEXT,
  ADD COLUMN IF NOT EXISTS "enrichmentError" TEXT;

-- Index on enrichedAt so the cache gate (party.enrichedAt < 30d) can
-- find rows cheaply when scanning for parties due for re-fetch.
CREATE INDEX IF NOT EXISTS "parties_tenantId_enrichedAt_idx"
  ON "parties" ("tenantId", "enrichedAt");
