-- Fase 4.1 — limpar o prefixo de país duplicado no NIF-IVA.
--
-- Bug real apanhado no smoke de produção: `ViesService.validateParty`
-- colava o código do país a um NIF-IVA que já o trazia
-- ("ES" + "ESB09802059" = "ESESB09802059"). O VIES era consultado com o
-- número errado, respondia "não existe", e TODOS os fornecedores
-- estrangeiros apareciam como inválidos — com o valor corrompido
-- gravado em `vatNumber` e um veredicto falso em `viesValid`.
--
-- Aqui limpamos o estrago para que a validação seguinte corra com o
-- número certo. Não apagamos o `nif`, que é a identidade do fornecedor.
UPDATE "parties"
  SET "vatNumber"       = NULL,
      "viesValid"       = NULL,
      "viesValidatedAt" = NULL,
      "viesName"        = NULL,
      "viesAddress"     = NULL
  WHERE "vatNumber" ~ '^([A-Z]{2})\1';
