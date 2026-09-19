-- Fase 4 — fornecedores completos: perfil fiscal/comercial, VIES, câmbio, auto-categoria.
-- Escrita à mão (sem shadow DB). Sem backfill destrutivo.

CREATE TYPE "VatRegime" AS ENUM ('PT', 'UE_REVERSE_CHARGE', 'EXTRA_UE');

ALTER TABLE "parties"
  ADD COLUMN "vatNumber" TEXT,
  ADD COLUMN "vatRegime" "VatRegime" NOT NULL DEFAULT 'PT',
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR',
  ADD COLUMN "directDebit" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "billingEmail" TEXT,
  ADD COLUMN "defaultCategoryId" TEXT,
  ADD COLUMN "viesValidatedAt" TIMESTAMP(3),
  ADD COLUMN "viesValid" BOOLEAN,
  ADD COLUMN "viesName" TEXT,
  ADD COLUMN "viesAddress" TEXT;

ALTER TABLE "parties"
  ADD CONSTRAINT "parties_defaultCategoryId_fkey"
  FOREIGN KEY ("defaultCategoryId") REFERENCES "categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "parties_tenantId_vatNumber_idx" ON "parties"("tenantId", "vatNumber");

CREATE TABLE "party_category_stats" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "partyId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "approvedCount" INTEGER NOT NULL DEFAULT 0,
  "lastApprovedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "party_category_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "party_category_stats_partyId_categoryId_key" ON "party_category_stats"("partyId", "categoryId");
CREATE INDEX "party_category_stats_tenantId_partyId_idx" ON "party_category_stats"("tenantId", "partyId");
ALTER TABLE "party_category_stats"
  ADD CONSTRAINT "party_category_stats_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "party_category_stats"
  ADD CONSTRAINT "party_category_stats_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "documents"
  ADD COLUMN "amountEur" DECIMAL(12,2),
  ADD COLUMN "exchangeRate" DECIMAL(14,6),
  ADD COLUMN "exchangeRateDate" TIMESTAMP(3);
