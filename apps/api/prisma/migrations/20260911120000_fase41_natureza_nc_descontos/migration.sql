-- Fase 4.1 — natureza da classificação, notas de crédito, descontos e
-- correção manual do operador.
--
-- Escrita à mão (não há shadow DB neste ambiente). Toda aditiva: não
-- apaga nem reescreve dados existentes.

-- ── Natureza contabilística ──────────────────────────────────────────
-- A HotelEquip é revendedora: a maioria das faturas é compra de
-- mercadoria para revenda, não despesa.
CREATE TYPE "CategoryNature" AS ENUM (
  'MERCADORIAS_REVENDA',
  'MATERIAS_PRIMAS_SUBSIDIARIAS',
  'SERVICOS_EXTERNOS',
  'DESPESA_OPERACIONAL',
  'IMOBILIZADO'
);

ALTER TABLE "categories"
  ADD COLUMN "nature" "CategoryNature" NOT NULL DEFAULT 'DESPESA_OPERACIONAL';

-- Natureza das categorias já semeadas. Serviços/FSE, comunicações e
-- rendas são fornecimentos e serviços externos; o resto é despesa
-- corrente. As categorias novas (mercadorias, matérias-primas,
-- imobilizado) são criadas pelo seed da aplicação.
UPDATE "categories" SET "nature" = 'SERVICOS_EXTERNOS'
  WHERE "slug" IN ('servicos-fse', 'comunicacoes', 'rendas');

ALTER TABLE "documents"
  ADD COLUMN "expenseNature" "CategoryNature",
  ADD COLUMN "typeManualOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fiscalStatusManualOverride" BOOLEAN NOT NULL DEFAULT false;

-- ── Notas de crédito ─────────────────────────────────────────────────
-- `total` fica como impresso; os `signed*` levam o sinal e são o que o
-- saldo de fornecedor e o apuramento de IVA somam directamente.
ALTER TABLE "documents"
  ADD COLUMN "signedTotal" DECIMAL(12,2),
  ADD COLUMN "signedTaxAmount" DECIMAL(12,2),
  ADD COLUMN "signedNetAmount" DECIMAL(12,2),
  ADD COLUMN "correctedDocNumber" TEXT,
  ADD COLUMN "correctedDocumentId" TEXT;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_correctedDocumentId_fkey"
  FOREIGN KEY ("correctedDocumentId") REFERENCES "documents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "documents_correctedDocumentId_idx" ON "documents"("correctedDocumentId");

-- Retroactivo: as notas de crédito já na base passam a ter os valores
-- com sinal. As restantes ficam com o sinal positivo.
UPDATE "documents"
  SET "signedTotal"     = CASE WHEN "type" = 'NOTA_CREDITO' THEN -"total"     ELSE "total"     END,
      "signedTaxAmount" = CASE WHEN "type" = 'NOTA_CREDITO' THEN -"taxAmount" ELSE "taxAmount" END,
      "signedNetAmount" = CASE WHEN "type" = 'NOTA_CREDITO' THEN -"netAmount" ELSE "netAmount" END
  WHERE "total" IS NOT NULL OR "taxAmount" IS NOT NULL OR "netAmount" IS NOT NULL;

-- ── Descontos ────────────────────────────────────────────────────────
ALTER TABLE "documents"
  ADD COLUMN "discountAmount" DECIMAL(12,2),
  ADD COLUMN "lineDiscountTotal" DECIMAL(12,2),
  ADD COLUMN "totalsReconciled" BOOLEAN,
  ADD COLUMN "totalsDelta" DECIMAL(12,2);

-- ── P2.3 — desligar a SABI ───────────────────────────────────────────
-- A SABI (Bureau van Dijk / Moody's) é uma base de dados paga que a
-- HotelEquip não subscreve. A ficha de entidade andava a mostrar
-- "sabi_api_key_missing" como se fosse uma avaria. O enriquecimento
-- passa a usar só o VIES (gratuito, sem chave) + os dados do documento
-- + edição manual, e os avisos antigos são limpos.
UPDATE "parties"
  SET "enrichmentError" = NULL
  WHERE "enrichmentError" ILIKE '%sabi%';

UPDATE "parties"
  SET "enrichmentSource" = NULL
  WHERE "enrichmentSource" = 'sabi-pt';
