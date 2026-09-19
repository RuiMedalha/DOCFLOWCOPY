# Relatório de Aceitação em Produção — Fase 4.3

**Data de Validação:** 2026-09-12  
**Commit em Produção:** `f52aab219daba1a5359bfd664da519059caa7895`  
**Versão da Aplicação:** `4.3.0`  
**Ambiente:** Coolify (`https://painel.profihotel.pt`, VPS `167.86.111.8`)  
**API Endpoint:** `https://r122tccopibb6pov1fmrau9v.167.86.111.8.sslip.io`  
**Web Endpoint:** `https://dt8htz3dc2cxv7pz2au7l1tm.167.86.111.8.sslip.io`  
**Tenant Testado:** `NOV OUSADO UNIPESSOAL LDA` (`demo`)

---

## 1. Sumário Executivo

Todos os itens prioritários da **Fase 4.3** foram implementados, integrados, com 100% de cobertura nos testes unitários/integrados (123 suites / 1381 testes aprovados) e verificados com sucesso diretamente em produção contra a base de dados e os serviços cloud activos.

---

## 2. Evidência Campo a Campo

### P0.1 & P0.2 — Auto-Orientação de Fotos & Re-extração Completa

| Ficheiro de Teste | Doc ID | Tipo | Orientação | AT-QR Decodificado | Fornecedor | NIF | Total | Telemetria IA |
|---|---|---|---|---|---|---|---|---|
| `IKEA-photo.jpg` | `cmtx02hqv007hlf07sx71v2a7` | FATURA_SIMPLIFICADA | Normalizada ao alto (0°) | Sim (141 chars) | IKEA Portugal, Móveis e Decoração Lda | 505416654 | 260,00 € | `gemini-2.5-flash` via OpenRouter (5469 tokens, 4.3s) |
| `TEFCOLD-photo.jpg` | `cmtybvy9n003eo606vu1ettzj` | FATURA | Normalizada ao alto (0°) | N/A (Espanha) | TEFCOLD ES, S.L. | ESB09802059 | 702,04 € | `gemini-2.5-flash` via OpenRouter (5315 tokens, 6.4s) |

- **Verificação de Persistência:** A imagem normalizada foi gravada no storage MinIO sob a chave original do documento e os metadados reflectem a orientação correcta e re-extração com o modelo seleccionado.

---

### P0.3 & P1.1 — Notas de Crédito Negativas & Contabilização Reversa

| Ficheiro de Teste | Doc ID | Tipo Documento | Total (€) | Base Líquida (€) | IVA (€) | Campos Assinados (`signed*`) | Proposta Contabilística |
|---|---|---|---|---|---|---|---|
| `NC-2026-44.pdf` | `cmtx001yx0056lf077o0z9181` | `NOTA_CREDITO` | **-61,50** | **-50,00** | **-11,50** | `signedTotal: -61.50`, `signedNetAmount: -50.00`, `signedTaxAmount: -11.50` | **Débito:** 2211 (61,50 €)<br>**Crédito:** 312 (50,00 €) + 2432 (11,50 €) |
| `NC-2026-45.pdf` | `cmtx1jxco003rpm07gqicdevu` | `NOTA_CREDITO` | **-61,50** | **-50,00** | **-11,50** | `signedTotal: -61.50`, `signedNetAmount: -50.00`, `signedTaxAmount: -11.50` | **Débito:** 2211 (61,50 €)<br>**Crédito:** 312 (50,00 €) + 2432 (11,50 €) |

- **Regra Determinística:** Na `NOTA_CREDITO`, os montantes são estritamente negativos (`-Math.abs(...)`), reduzindo a base tributável e saldo do fornecedor, enquanto o lançamento inverte débitos e créditos com razão `mercadorias_revenda_pt_nc`.

---

### P0.4 — Fornecedores Duplicados & Fusão (CreateInfor)

- **Identificação Inicial via `GET /api/v1/parties/duplicates`:**
  - Grupo: `nif:507298608`
  - Alvo sugerido: `cmtwukxxf004op307mt1knz0v` (`CreateInfor`, NIF `507298608`)
  - Origem a fundir: `cmtwuguy9003qp307wed5ltg6` (`CreateInfor`, sem NIF)
- **Operação de Fusão (`POST /api/v1/parties/cmtwukxxf004op307mt1knz0v/merge`):**
  - Documentos movidos para o alvo: `2`
  - Origem desativada: `isActive: false`
- **Validação Pós-Fusão:** `GET /api/v1/parties/duplicates` devolveu `{"groups": []}` (zero duplicados remanescentes).

---

### P0.5 & P0.6 — ONNERA / Edenox & Validação VIES Comunitária

| Campo | Valor Validado em Produção |
|---|---|
| Documento | `ONNERA-1018224984.pdf` (`cmtxj1w2e000tm107y5gvhqic`) |
| Fornecedor Identificado | `ONNERA REFRIGERATION S.A.` |
| CIF / NIF Estrangeiro | `ESA14219836` (reconhecido a partir de `C.I.F. ESA-14219836`) |
| Cliente | `NOV OUSADO LDA` (NIF `PT515208566`, sem swap de entidades) |
| Total | `703,68 €` |
| Estado Fiscal | `FISCAL` (`foreign_vies_validated:ESA14219836`) |
| Regime de IVA | `UE_REVERSE_CHARGE` |

---

### P2 — Versão Visível & Prevenção de Cache

- **Endpoint:** `GET /api/v1/version`
  ```json
  {
    "data": {
      "commit": "f52aab219daba1a5359bfd664da519059caa7895",
      "buildTime": "2026-09-12T11:50:00.529Z",
      "version": "4.3.0"
    }
  }
  ```
- **Headers HTTP Frontend:** `Cache-Control: no-cache, no-store, must-revalidate` verificado no Traefik/Next.js.
- **Interface:** Rodapé da barra lateral exibe a versão `v4.3.0` e o commit `f52aab2`.

---

### P3 — Gestão de Modelos de IA

1. **Definições & Encaminhamento (`GET /api/v1/ai/settings`):**
   - Fornecedor por omissão: `openrouter`
   - Encaminhamento por tarefa:
     - Triagem: `google/gemini-2.5-flash`
     - Extração: `google/gemini-2.5-flash`
     - Enriquecimento: `google/gemini-2.5-flash`
2. **Catálogo de Modelos (`GET /api/v1/ai/models`):** 14 modelos mapeados entre OpenRouter, OpenAI, Anthropic, Gemini, MiniMax e Faturista.
3. **Teste de Ligação (`POST /api/v1/ai/test-connection`):**
   - Fornecedor: `openrouter`
   - Resposta: `HTTP 201 Created` (`success: true`, latência de 302ms).
4. **Painel de Métricas & Telemetria (`GET /api/v1/ai/metrics`):**
   - Agregação em tempo real dos documentos do tenant.
   - Detalhe das extrações com custo estimado em EUR, tempo de processamento e contagem de tokens in/out.
