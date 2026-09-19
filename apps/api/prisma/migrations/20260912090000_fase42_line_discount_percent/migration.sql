-- Fase 4.2 (P0.3) — percentagem de desconto por linha.
--
-- O valor impresso na coluna de desconto pode ser uma percentagem
-- (a SAMMIC imprime "Dto. 30,00" = 30%, não 30 €). `discount` continua
-- a guardar o VALOR resolvido em euros; esta coluna nova guarda a
-- percentagem quando a classificação determinística a confirmou, para
-- a interface poder mostrar "30%" em vez de "30,00 EUR".
ALTER TABLE "document_items"
  ADD COLUMN "discountPercent" DECIMAL(6,3);
