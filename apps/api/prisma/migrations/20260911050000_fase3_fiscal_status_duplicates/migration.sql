-- Fase 3 — validade fiscal, tipos alargados e duplicados por chave fiscal.
--
-- Escrita à mão (o `prisma migrate dev` precisa de shadow DB que não existe
-- neste ambiente). Sem backfill destrutivo: linhas existentes ficam
-- fiscalStatus = INDETERMINADO até à próxima re-extração.
--
-- Os novos valores de enum NÃO podem ser usados na mesma transação em que
-- são criados (Postgres), por isso o índice único parcial que referencia
-- 'DUPLICADO' vive na migration seguinte.

-- Tipos de documento não fiscais / simplificados
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'PROFORMA';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'ORCAMENTO';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'AVISO_PAGAMENTO';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'EXTRATO_FORNECEDOR';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'FATURA_SIMPLIFICADA';

-- Estado de duplicado
ALTER TYPE "DocumentStatus" ADD VALUE IF NOT EXISTS 'DUPLICADO';

-- Validade fiscal
CREATE TYPE "FiscalStatus" AS ENUM ('FISCAL', 'NAO_FISCAL', 'INDETERMINADO');

ALTER TABLE "documents"
  ADD COLUMN "fiscalStatus" "FiscalStatus" NOT NULL DEFAULT 'INDETERMINADO',
  ADD COLUMN "fiscalReason" TEXT,
  ADD COLUMN "docNumberNorm" TEXT,
  ADD COLUMN "duplicateOfId" TEXT;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_duplicateOfId_fkey"
  FOREIGN KEY ("duplicateOfId") REFERENCES "documents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "documents_tenantId_supplierNif_docNumberNorm_idx"
  ON "documents"("tenantId", "supplierNif", "docNumberNorm");
CREATE INDEX "documents_tenantId_fiscalStatus_idx"
  ON "documents"("tenantId", "fiscalStatus");
