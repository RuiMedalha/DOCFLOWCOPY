-- =============================================================================
-- Sprint E fix-up — promote parties(tenantId, slug) to UNIQUE
-- =============================================================================
--
-- Audit §8 LOW-4 (also linked to §5 LOW-3 — slug race): the original
-- `add_party_categories` migration created a plain non-unique index on
-- `parties("tenantId", "slug")`. Two concurrent creates with the same
-- name could both pass `generateUniqueSlug`'s findFirst and both insert
-- the same slug — the second silently won the index hit without any DB-
-- level enforcement.
--
-- This migration drops the non-unique index and recreates it as a
-- UNIQUE index. The slug column is nullable; Postgres treats each NULL
-- as distinct in a unique index by default, so the index still allows
-- multiple parties with `slug IS NULL` (rows created before Sprint E
-- or parties whose name hasn't been set yet).
--
-- SAFE-TO-APPLY: the migration fails loudly if existing rows already
-- duplicate `(tenantId, slug)`. The pre-deploy check below identifies
-- such rows; if any are found, resolve them BEFORE running this
-- migration (e.g. by appending `<id.slice(0,4)>` to the duplicates).
--
-- PRE-DEPLOY CHECK (run once on the live DB):
--   SELECT "tenantId", slug, COUNT(*) AS n
--   FROM parties
--   WHERE slug IS NOT NULL
--   GROUP BY "tenantId", slug
--   HAVING COUNT(*) > 1;
-- Expected: zero rows.

-- Drop the non-unique composite index from the original Sprint E migration.
DROP INDEX IF EXISTS "parties_tenantId_slug_idx";

-- Recreate as a UNIQUE index. Name follows the Prisma convention for
-- `@@unique([tenantId, slug])` so the generated Prisma client agrees.
CREATE UNIQUE INDEX "parties_tenantId_slug_key"
  ON "parties"("tenantId", "slug");
