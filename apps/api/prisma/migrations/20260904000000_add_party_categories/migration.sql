-- =============================================================================
-- Sprint E — PartyCategory (master-party classification) + Party.slug
-- =============================================================================
--
-- Two new surfaces:
--
--   1. New table `party_categories` (per-tenant). Conceptually distinct from
--      the existing `categories` table (which classifies documents by expense
--      type). A PartyCategory segments the master Party list — e.g.
--      "Estratégico", "Operacional", "Consultor / Serviços", "Recorrente" —
--      and drives the on-disk folder routing in
--      `apps/api/src/modules/documents/storage/path-builder.ts`.
--      Seeded on demand via PartyCategoriesService.ensureSeedForTenant.
--
--   2. Two new columns on `parties`:
--      - `slug`           TEXT NULL — kebab-case ASCII of the party name,
--        persisted so the storage folder path stays stable across renames
--        (Sprint E brief). Populated on create / on PATCH `name` with a
--        collision suffix `<slug>-<id.slice(0,4)>`.
--      - `partyCategoryId` TEXT NULL — FK to `party_categories.id`. SetNull
--        on category delete so an operator can reclassify without
--        orphaning the party.
--
-- Both changes are backward-compatible: existing parties get NULL for
-- `slug` / `partyCategoryId`, the service fills them on the next PATCH.
--
-- CRITICAL ORDERING: the FK from `parties.partyCategoryId` references
-- `party_categories(id)`, so the table MUST exist before that FK is added.
-- Postgres evaluates FK constraints at column-add time, hence the
-- explicit two-pass split below.

-- ─── Party categories: create the table BEFORE anything references it ───
CREATE TABLE "party_categories" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "color"     TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_categories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "party_categories_tenantId_idx"
  ON "party_categories"("tenantId");

CREATE UNIQUE INDEX "party_categories_tenantId_slug_key"
  ON "party_categories"("tenantId", "slug");

ALTER TABLE "party_categories"
  ADD CONSTRAINT "party_categories_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Parties: new columns + indexes + FK to party_categories ───────────
ALTER TABLE "parties"
  ADD COLUMN "partyCategoryId" TEXT,
  ADD COLUMN "slug"             TEXT;

CREATE INDEX "parties_tenantId_slug_idx"
  ON "parties"("tenantId", "slug");

CREATE INDEX "parties_tenantId_partyCategoryId_idx"
  ON "parties"("tenantId", "partyCategoryId");

ALTER TABLE "parties"
  ADD CONSTRAINT "parties_partyCategoryId_fkey"
  FOREIGN KEY ("partyCategoryId") REFERENCES "party_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
