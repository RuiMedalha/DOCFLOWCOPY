# Benchmark de leitura — DocFlow

Corrido **em produção**, contra os documentos reais do cliente, não contra
fixtures. O script vive fora do repositório (é descartável); o que interessa
é o resultado e o que ele revelou.

- Modelo de visão: **Gemini 2.5 Flash via OpenRouter** (`OPENROUTER_API_KEY`,
  `VISION_PROVIDER_ORDER=openrouter,gemini,minimax,openai,anthropic`).
  Não há chave direta da Google neste deployment — o repositório de
  referência `gemini-documental` chama `generativelanguage.googleapis.com`
  diretamente, por isso não existe comparação 1:1. Uma comparação
  equivalente é possível com `OPENROUTER_MODEL=google/gemini-2.0-flash-001`.
- Descodificação do QR-AT: ZXing + jsQR em worker thread, com rasterização
  de PDF a escala 3.

---

## Fase 4.1 — 2026-09-11 (37 documentos)

Amostra: as 19 amostras reais do cliente, mais as faturas estrangeiras que
falharam no teste do Rui, mais fixtures sintéticos para casos que as
amostras não cobriam (nota de crédito, desconto global, foto deitada sem
EXIF, fatura em GBP).

### Resultado global

| Métrica | Valor |
|---|---|
| Documentos | 37 |
| `FISCAL` (QR-AT válido ou NIF-IVA validado no VIES) | 18 |
| `NAO_FISCAL` (orçamento, proforma, encomenda, aviso, extrato) | 6 |
| `INDETERMINADO` (vão para revisão) | 13 |
| Com NIF gravado (todos validados por módulo 11 ou VIES) | 31 |
| Com ATCUD | 21 |
| QR-AT descodificado deterministicamente | 17 |
| ATCUD presente nos documentos PT fiscais | **13/13** |
| Totais que fecham ao cêntimo | 27 |
| Totais que não fecham (vão para revisão com o motivo) | 10 |

### O que o benchmark revelou

Correr isto contra documentos reais — em vez de confiar nos testes — apanhou
quatro defeitos que os testes unitários não podiam apanhar:

1. **Cinco documentos tinham o TOTAL gravado na coluna do ATCUD**
   (`1012.30`, `155.00`, `32.40`, `1.94`, `918.60`). Corrigir a escrita não
   chegava: a extração é aditiva e nunca limpava o que já lá estava.
2. **O VIES era consultado com o número errado.** O código colava o país a
   um NIF-IVA que já o trazia (`ES` + `ESB09802059` = `ESESB09802059`), e
   por isso TODOS os fornecedores estrangeiros apareciam como inválidos.
   Depois da correção: TEFCOLD, SAMMIC, Arilex e GALP validam.
3. **O derivado PDF nunca era reconstruído.** Medir os bytes (em vez de
   confiar na existência do `pdfKey`) mostrou PDFs do tamanho do original.
   A dependência era injetada a partir de um `import type`, que apaga a
   classe em tempo de execução. Era esta a razão de as fotos continuarem
   deitadas e com 3 MB.
4. **A regra dos totais acusava 20 em 37 documentos.** Assumia que o
   fornecedor imprime o total da linha líquido e que o desconto global
   ainda não está aplicado. Nenhuma das duas coisas é universal —
   corrigida, passou de 17 para **27 documentos a fechar** e os 10 que
   restam são diferenças reais (a SAMMIC tem mesmo 0,81 € por explicar)
   ou faturas em que o modelo truncou linhas.

### Documentos estrangeiros (os que falharam no teste do Rui)

| Documento | Antes | Agora |
|---|---|---|
| `VOV26009084` TEFCOLD ES (oferta de venta) | `FISCAL`, NIF `500000001` e ATCUD `ABC1234-56789` inventados, 90 % de confiança | `ORCAMENTO` / `NAO_FISCAL` (`keyword:orcamento`), sem ATCUD, confiança limitada a 0,5 |
| `VTA30456237` SAMMIC (ES) | entidade separada, NIF-IVA por validar | `FISCAL`, `ESB20869152` validado no VIES, regime autoliquidação |
| `VFV26001324` Arilex (ES) | NIF-IVA por validar | `FISCAL`, `ESB06700785` validado no VIES |
| `FE-0220100158006…` GALP España | NIF-IVA por validar | `FISCAL`, `ESA28559573` validado no VIES |
| `2-FA238674` SAS Casselin (FR) | NIF-IVA por validar | VIES não confirma `FR04540090727` → NIF **não** é gravado, documento vai para revisão |
| `INV-2026-00417` Catering Supplies (GB) | NIF-IVA por validar | Extra-UE: nunca é NIF confirmado, fica como texto não validado |

O caso da Casselin é o comportamento pretendido, não uma falha: o VIES não
confirma aquele número, por isso **não** é gravado como identificador. Ou o
modelo leu um dígito mal, ou o fornecedor não está registado para operações
intracomunitárias — em qualquer dos casos, a decisão é de um humano.

### Fotos (P1.4)

| Foto | Original | PDF de arquivo | Rotação detetada |
|---|---|---|---|
| CREATEINFOR FT-FA-2026-4791 | 2753 KB | **481 KB** | 90° (texto na vertical) |
| CREATEINFOR FT-FA-2026-2285 | 2823 KB | **353 KB** | 90° (texto na vertical) |
| CREATEINFOR FT-FA-2026-4791 (2.ª) | 2760 KB | **490 KB** | 90° (texto na vertical) |
| TEFCOLD VOV26009084 | 3287 KB | **427 KB** | 0° (já direita) |
| IKEA (foto deitada sem EXIF) | 475 KB | **396 KB** | 0° após correção EXIF |

Todas abaixo dos 500 KB pedidos, com o QR-AT ainda legível depois da
compressão (verificado descodificando-o outra vez sobre os bytes
comprimidos). As fotos da CREATEINFOR estavam **mesmo** deitadas — e não
traziam etiqueta EXIF, que era exactamente o caso que a rotação anterior
não apanhava.

---

## Fase 2 — 2026-09-11 (histórico)

O primeiro benchmark, que estabeleceu a linha de base da leitura. Duas
conclusões que continuam válidas:

- Um QR "lido" pelo modelo nunca é prova: o modelo troca caracteres
  (`JJY2HD8C` vs `JJY2HD80` em duas fotos do mesmo talão do IKEA). Só um
  QR descodificado por ZXing/jsQR vale como certificação.
- A cascata de descodificação bloqueava o event loop 5–40 s por imagem, o
  que fazia o healthcheck do Docker falhar a meio do benchmark. Passou a
  correr em worker thread.
