-- =============================================================================
-- Sprint G — Party 360° file: PartyContact + PartyAddress
-- =============================================================================
--
-- One-to-many from Party. Contacts are the named people you can reach out
-- to (CFO, contabilista, comercial). Addresses are the physical locations
-- a party has, classified by `PartyAddressType` (BILLING / CORRESPONDENCE /
-- OPERATIONAL / OTHER).
--
-- Migration of legacy flatten columns (email / phone / mobile / address /
-- city / postalCode / country on the `parties` table) is intentionally
-- OUT OF SCOPE — admin populates these new tables manually via UI, the
-- flatten columns stay read/write as before.
--
-- `party_contacts`: unique per (tenantId, partyId, email). Postgres treats
-- NULL as distinct in unique indexes, so multiple contacts without an
-- email on the same party are allowed. Service layer normalises "" → null
-- before insert so empty strings don't conflict on the unique index.
--
-- `party_addresses`: `isPrimary` is enforced per (partyId, type) at the
-- service layer with `pg_advisory_xact_lock(hashtext('party_address_primary:'
-- || partyId || ':' || type))` — Prisma 4 doesn't expose partial unique
-- indexes in the DSL. The compound (partyId, type, isPrimary) index keeps
-- "find the primary of type X" cheap.

-- CreateEnum
CREATE TYPE "PartyAddressType" AS ENUM ('BILLING', 'CORRESPONDENCE', 'OPERATIONAL', 'OTHER');

-- CreateTable
CREATE TABLE "party_contacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_addresses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "type" "PartyAddressType" NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'PT',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "party_contacts_partyId_idx" ON "party_contacts"("partyId");

-- CreateIndex
CREATE INDEX "party_contacts_tenantId_partyId_idx" ON "party_contacts"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "party_contacts_tenantId_partyId_email_key" ON "party_contacts"("tenantId", "partyId", "email");

-- CreateIndex
CREATE INDEX "party_addresses_partyId_idx" ON "party_addresses"("partyId");

-- CreateIndex
CREATE INDEX "party_addresses_partyId_type_isPrimary_idx" ON "party_addresses"("partyId", "type", "isPrimary");

-- AddForeignKey
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_addresses" ADD CONSTRAINT "party_addresses_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
