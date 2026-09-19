# Inventário das amostras reais — `C:\Projetos\docflow-mvp\samples`

Data: 2026-09-11 (Fase 0). Pasta git-ignored; os ficheiros **não** estão no repo.

Método: `pdf-parse` (texto nativo, nº páginas, nº de imagens embebidas) e `jimp + jsQR` (QR nas fotos).
A coluna "QR-AT" para PDFs digitalizados (sem texto) fica **por confirmar** — só com rasterização + ZXing
(pipeline da Fase 2) se sabe se o QR impresso é legível. "ATCUD no texto" é o indicador fiável nos PDFs nativos.

| # | Ficheiro | KB | Tipo | Págs | Texto nativo | ATCUD no texto | QR-AT | Notas |
|---|----------|----|------|------|--------------|----------------|-------|-------|
| 1 | `BP 30,00 €.pdf` | 380 | PDF scan | 2 | não (16 chars) | — | por confirmar | 2 imagens; provável recibo/talão |
| 2 | `FR 1 8482 BONEZINHO.pdf` | 236 | PDF scan | 1 | não | — | por confirmar | fatura-recibo |
| 3 | `FR 101 00049652 Almoço.pdf` | 220 | PDF scan | 1 | não | — | por confirmar | fatura-recibo restauração |
| 4 | `FR FV 010C.FV 448 Alcides.pdf` | 245 | PDF scan | 1 | não | — | por confirmar | fatura-recibo |
| 5 | `FT 1 74609 Refeição.pdf` | 180 | PDF scan | 1 | não | — | por confirmar | fatura restauração |
| 6 | `FT 1 8376 Refeição.pdf` | 218 | PDF scan | 1 | não | — | por confirmar | fatura restauração |
| 7 | `FT 2026 1396 AZUR NET 190,65€.pdf` | 314 | PDF scan | 2 | não | — | por confirmar | 2 páginas imagem |
| 8 | `FT 2026A92 6384 Miranda e Serra 2.030,68€.pdf` | 161 | PDF nativo | 1 | sim (2034) | **sim** | provável (3 imgs) | fatura fornecedor |
| 9 | `FT 2026A92 6781 Miranda e Serra 1.245,13€.pdf` | 161 | PDF nativo | 1 | sim (2052) | **sim** | provável (3 imgs) | mesmo fornecedor que #8 (bom para teste de dedup por chave fiscal) |
| 10 | `FT 2026A94 149 Miranda e serra 2 223.82€  13 mar.pdf` | 1006 | PDF scan | 1 | não | — | por confirmar | mesmo fornecedor, mas digitalizado (teste papel vs digital) |
| 11 | `FT 4 83 5638 PAGO 1.129,88€.pdf` | 72 | PDF nativo | 4 | sim (4980) | **sim** | sem imagens (QR pode ser vetorial) | 4 páginas; marcado "PAGO" |
| 12 | `FT 76  1944 LIZOTEL 418,10 €.pdf` | 666 | PDF scan | 1 | não | — | por confirmar | |
| 13 | `FT FAT2026 396 QUI-LIBRA 279,21€.pdf` | 234 | PDF nativo | 4 | sim (4896) | **sim** | provável (4 imgs) | |
| 14 | `FT FE 0220100158006AA0E03822026000001180.pdf` | 343 | PDF scan | 1 | não | — | por confirmar | nome sugere fatura eletrónica (FE) |
| 15 | `FT VFV26000793 296,61€.pdf` | 185 | PDF nativo | 1 | sim (1677) | não | provável (2 imgs) | sem ATCUD no texto — candidato a NAO_FISCAL/INDETERMINADO ou QR só em imagem |
| 16 | `FT VFV26001324 PAGO 323,82€.pdf` | 247 | PDF nativo | 1 | sim (1786) | não | provável (2 imgs) | idem #15, mesmo emitente |
| 17 | `FT_AAA26_05582.pdf` | 44 | PDF nativo | 2 | sim (4915) | **sim** | provável (1 img) | |
| 18 | `WhatsApp Image 2026-09-11 at 01.25.47 (1).jpeg` | 262 | Foto JPEG | 1 | — | — | jsQR simples **não** leu | 1536×2048; precisa do cascade ZXing + pré-processamento |
| 19 | `WhatsApp Image 2026-09-11 at 01.25.47.jpeg` | 296 | Foto JPEG | 1 | — | — | jsQR simples **não** leu | 1536×2048; idem |

## Resumo

| Categoria | Quantidade | Ficheiros |
|-----------|-----------|-----------|
| PDF nativo com ATCUD no texto | 5 | #8, #9, #11, #13, #17 |
| PDF nativo sem ATCUD no texto | 2 | #15, #16 |
| PDF só imagem (scan) | 10 | #1–#7, #10, #12, #14 |
| Fotos JPEG (WhatsApp) | 2 | #18, #19 |
| Sem HEIC nas amostras | 0 | — (Fase 2 precisa de um HEIC de teste; pedir ao Rui ou gerar) |

Tamanho total ≈ 5,6 MB. Nenhum ficheiro acima de 1,1 MB.

## Casos de teste que estas amostras cobrem

- **Dedup por chave fiscal** (Fase 3): #8/#9/#10 são do mesmo fornecedor (Miranda e Serra); #10 é o mesmo tipo em papel digitalizado.
- **Papel vs digital**: #10 (scan) vs #8/#9 (nativo).
- **Multi-página**: #11 (4 págs), #13 (4 págs), #17, #1, #7 (2 págs).
- **Fotos de telemóvel** com orientação EXIF: #18, #19.
- **Documento "PAGO"**: #11, #16 (teste de calendário/estado de pagamento).
- **Sem ATCUD no texto nativo**: #15, #16 (teste da regra FISCAL/INDETERMINADO).

## O que falta nas amostras (pedir ao Rui quando for útil)

- Um HEIC/HEIF real do iPhone (Fase 2).
- Uma proforma/orçamento (Fase 3 — regra `NAO_FISCAL`).
- Uma fatura estrangeira intra-UE (Fase 4 — VIES/autoliquidação) e uma em moeda ≠ EUR.
- Um extrato bancário CSV real (Fase 5).
