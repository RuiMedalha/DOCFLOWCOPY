-- Fase 3 — índice ÚNICO PARCIAL da chave fiscal. Garante que só existe um
-- documento "vivo" por (tenant, NIF emitente, nº documento normalizado,
-- ATCUD ou ''). Linhas DUPLICADO e apagadas ficam de fora, por isso o
-- duplicado guarda os mesmos campos sem violar o índice. Vive numa
-- migration própria porque usa o valor de enum criado na anterior.
CREATE UNIQUE INDEX IF NOT EXISTS "documents_fiscal_key_unique"
  ON "documents" ("tenantId", "supplierNif", "docNumberNorm", COALESCE("atcud", ''))
  WHERE "status" <> 'DUPLICADO'
    AND "deletedAt" IS NULL
    AND "supplierNif" IS NOT NULL
    AND "docNumberNorm" IS NOT NULL;
