# Relatório de Diagnóstico e Resolução Completa: Classificação Fiscal, Contas a Pagar, Gravação e Processamento de Imagens

> **Data:** 16 de Setembro de 2026  
> **Sistema:** DocFlow MVP  
> **Ambiente de Produção:** `https://dt8htz3dc2cxv7pz2au7l1tm.167.86.111.8.sslip.io` (Web) / `https://r122tccopibb6pov1fmrau9v.167.86.111.8.sslip.io` (API)  
> **Módulos Abrangidos:** `Extraction (fiscal-status)`, `Documents`, `Payments (Contas a Pagar)`, `ImageEnhancer (Sharp/PDF)`, `Filters (AllExceptionsFilter)`, `Web (Dashboard/Detail/Inbox)`

---

## 1. Sumário Executivo

Este documento consolida a análise detalhada e a resolução definitiva de todas as ocorrências reportadas no ambiente de produção:

1. **Erro de Parâmetros ao Guardar Documento (400 Bad Request / Prisma Validation Error)**:
   * Ao tentar alterar o tipo do documento `cmu3a59o5004hp707c5687o1t` para `FATURA_SIMPLIFICADA` e preencher o NIF do fornecedor (`519119673`), a interface devolvia erro 400.
   * O documento não saía do separador de "Encomendas / Pedidos" para o separador de "Faturas".
2. **Classificação Inicial Incorreta como `ENCOMENDA`**:
   * O documento (talão do Restaurante Clipper com QR-code fiscal `D:FS` e ATCUD `J6X6VH9D-3085`) foi classificado como `ENCOMENDA` com validade fiscal `NAO_APLICAVEL`.
3. **Ausência de Documentos em "Contas a Pagar" (`/payments`)**:
   * Documentos com datas de pagamento/vencimento não apareciam na tabela de pagamentos.
4. **Tratamento de Imagens, Derivado PDF e Nomes de Ficheiro**:
   * Imagens mantinham extensões `.jpg`, URLs sem o nome amigável e dúvidas sobre o recorte/sharp na extração.

---

## 2. Diagnóstico Técnico das Causas Raiz

### 2.1. Erro 400 ao Guardar (`PrismaValidationError: Invalid query parameters`)

Ao inspecionar o payload enviado pelo frontend no clique de "Guardar" (`PATCH /api/v1/documents/:id`):

```json
{
  "type": "FATURA_SIMPLIFICADA",
  "status": "APROVADO",
  "fiscalStatus": "FISCAL",
  "supplier": "Restaurante Clipper",
  "supplierNif": "519119673",
  "docNumber": "J6X6VH9D-3085",
  "total": 49.7,
  "taxAmount": 5.72,
  "netAmount": 43.98,
  "expenseCategory": null,
  "paymentMethod": null,
  "fileName": "RESTAURANTE-CLIPPER_2026-09-15_J6X6VH9D-3085.jpg"
}
```

Ocorreram três falhas acumuladas no backend:
1. **`property fileName should not exist`**:
   * O DTO `UpdateDocumentDto` em produção não continha o campo `fileName`. O NestJS `ValidationPipe` (com `forbidNonWhitelisted: true`) rejeitava o pedido com HTTP 400.
2. **`PrismaValidationError: Unknown argument 'paymentMethod'`**:
   * O campo `paymentMethod` não existe como coluna na tabela `Document` do Prisma (reside dentro de `metadata` em formato JSON). Ao fazer `const data = { ...dto }` e enviar para `prisma.document.update({ data })`, o Prisma lançava `PrismaClientValidationError`.
3. **`Invalid expenseCategory`**:
   * Quando o frontend enviava `"expenseCategory": null`, a validação `if (!isExpenseCategory(dto.expenseCategory))` rejeitava o valor em vez de o tratar como limpeza de categoria (`null`).
4. **Mascaramento no Filtro Global de Exceções (`AllExceptionsFilter`)**:
   * O filtro global capturava `PrismaClientValidationError` e substituía a mensagem real por uma constante genérica `"Invalid query parameters"`, ocultando o nome do campo com erro e impossibilitando o diagnóstico direto nos logs do cliente.

---

### 2.2. Por que a Fatura Simplificada foi classificada como `ENCOMENDA`?

No código de `classifyFiscalStatus` ([`apps/api/src/modules/extraction/fiscal-status.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/extraction/fiscal-status.ts)):

1. O payload do QR-code do talão é:
   `A:515208566*B:515208566*C:PT*D:FS*E:20260915*F:A2605/3085*G:J6X6VH9D-3085*H:43.98*I1:13*J1:5.72*L:49.70*M:1*N:22513/AT`
2. No sistema POS do emissor, quer o campo `A:` (NIF emitente) quer o campo `B:` (NIF adquirente) continham o NIF `515208566` (o NIF do tenant "NOV OUSADO UNIPESSOAL LDA").
3. O classificador continha a regra:
   ```ts
   if (tenantNifClean && issuerNifClean && tenantNifClean === issuerNifClean) { ... }
   ```
   Esta regra apenas verificava texto OCR (`input.text`) à procura de palavras como "fatura simplificada". Como o documento era uma fotografia recente sem OCR prévio ou sem camada de texto (`textSource: none`), a expressão falhava.
4. O classificador caía na linha seguinte:
   ```ts
   const nonFiscalType = kind ?? 'ENCOMENDA';
   return {
     fiscalStatus: 'NAO_APLICAVEL',
     reason: `own_company_is_issuer:${tenantNifClean}`,
     documentType: nonFiscalType,
   };
   ```
   Classificava o talão fiscal como `ENCOMENDA` e `NAO_APLICAVEL`.

---

### 2.3. Por que o documento não saía do separador de "Encomendas"?

O separador de documentos ([`apps/web/app/(dashboard)/documents/_components/inbox-tabs.tsx`](file:///C:/Projetos/docflow-mvp/apps/web/app/(dashboard)/documents/_components/inbox-tabs.tsx)) filtra:
* **Separador "Encomendas / Pedidos"**: `type: 'ENCOMENDA'`.
* **Separador "Todas as Faturas (Fiscais)"**: `excludeType: 'ENCOMENDA'` e `fiscalStatus != 'NAO_APLICAVEL'`.

Como a gravação manual dava erro 400, o documento nunca era alterado na base de dados, mantendo `type: 'ENCOMENDA'` e `fiscalStatus: 'NAO_APLICAVEL'`. Ao corrigir o erro 400 e permitir guardar, o backend atualiza automaticamente:
* `type = 'FATURA_SIMPLIFICADA'`
* `fiscalStatus = 'FISCAL'` (via promoção automática quando o utilizador escolhe um tipo fiscal)
* `isNonFiscalDoc = false`

Com isto, o documento **sai imediatamente** do separador de Encomendas e entra em **Todas as Faturas (Fiscais)**.

---

### 2.4. Por que não apareciam em "Contas a Pagar"?

1. **Separação de Entidades**: O ecrã de Contas a Pagar consulta a tabela `PayableItem`. A extração e o formulário de documento apenas escreviam na tabela `Document`.
2. As rotinas de sincronização contínua (`syncPayableForDocument`) e auto-cura (`syncMissingDocumentPayables`) estavam concluídas no repositório mas ainda não tinham sido instaladas no servidor remoto.

---

## 3. Correções Implementadas

### 3.1. DTO e Validação Resiliente
Arquivo: [`apps/api/src/modules/documents/dto/document.dto.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/documents/dto/document.dto.ts)

* Adicionado `@ValidateIf((_, val) => val !== null && val !== undefined && val !== '')` e tipagens `| null` em todos os campos opcionais de `UpdateDocumentDto` (`fileName`, `supplier`, `supplierNif`, `customer`, `customerNif`, `docNumber`, `docDate`, `dueDate`, `total`, `taxAmount`, `netAmount`, `currency`, `tags`, `folderId`, `expenseCategory`, `expenseCategoryId`, `expenseNature`, `fiscalStatus`, `partyId`, `paymentStatus`, `paymentMethod`, `paymentDueDate`).
* Desta forma, strings vazias (`""`) ou `null` enviados pelo frontend nunca mais quebram a validação.

### 3.2. Sanitização no Serviço de Documentos
Arquivo: [`apps/api/src/modules/documents/documents.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/documents/documents.service.ts)

1. **Tratamento de `expenseCategory`**:
   ```ts
   if (dto.expenseCategory !== undefined) {
     if (dto.expenseCategory === '' || dto.expenseCategory === null) {
       manualCategory = null; // Limpeza explícita
     } else if (!isExpenseCategory(dto.expenseCategory)) {
       throw new BadRequestException(`Invalid expenseCategory...`);
     } else {
       manualCategory = dto.expenseCategory;
     }
   }
   ```
2. **Remoção de Campos Fora do Esquema Prisma**:
   ```ts
   delete data.expenseCategory;
   delete data.resetClassificationOverride;
   delete data.paymentMethod;
   ```
3. **Conversão de Strings Vazias em `null` para Chaves Estrangeiras**:
   ```ts
   if (data.partyId === '') data.partyId = null;
   if (data.expenseCategoryId === '') data.expenseCategoryId = null;
   if (data.folderId === '') data.folderId = null;
   if (data.supplierNif === '') data.supplierNif = null;
   if (data.customerNif === '') data.customerNif = null;
   if (data.docNumber === '') data.docNumber = null;
   ```

### 3.3. Melhoria no Filtro de Exceções
Arquivo: [`apps/api/src/common/filters/all-exceptions.filter.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/common/filters/all-exceptions.filter.ts)

* Em caso de `PrismaClientValidationError`, a mensagem original do Prisma é limpa e registada no log de erro, e devolvida na resposta HTTP, eliminando completamente erros genéricos silenciosos.

### 3.4. Reconhecimento Determinístico no Classificador Fiscal
Arquivo: [`apps/api/src/modules/extraction/fiscal-status.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/extraction/fiscal-status.ts)

* Mesmo quando `tenantNifClean === issuerNifClean`, o classificador analisa diretamente o tipo no QR-code:
  ```ts
  const rawQrType = (input.qr?.documentType ?? '').toUpperCase();
  const isSimplified =
    rawQrType === 'FS' ||
    rawQrType === 'FR' ||
    /\b(?:fatura\s+simplificada|factura\s+simplificada|\bFS\b|\bFR\b|fatura[\s/-]?recibo)\b/i.test(input.text || '');

  if (tenantNifClean && issuerNifClean && tenantNifClean === issuerNifClean) {
    if (isSimplified) {
      return {
        fiscalStatus: 'FISCAL',
        reason: 'simplified_invoice_expense',
        documentType: rawQrType === 'FR' ? 'FATURA_RECIBO' : 'FATURA_SIMPLIFICADA',
      };
    }
    // ...
  }
  ```
* Desta forma, qualquer Fatura Simplificada com QR `D:FS` é catalogada como `FISCAL` e `FATURA_SIMPLIFICADA`, independentemente do texto OCR ou de coincidências no NIF emitente.

### 3.5. Nome de Ficheiro Padronizado e Download em PDF
Arquivos:
* [`apps/api/src/modules/documents/documents.controller.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/documents/documents.controller.ts)
* [`apps/web/app/(dashboard)/documents/[id]/_lib/use-document-detail.ts`](file:///C:/Projetos/docflow-mvp/apps/web/app/(dashboard)/documents/[id]/_lib/use-document-detail.ts)

1. A rota de download aceita o nome de ficheiro no caminho:
   `GET /api/v1/documents/:id/download/:fileName?format=pdf`
2. O hook `useDownloadUrl` assegura que quando o formato pretendido é `'pdf'`, a extensão é garantidamente `.pdf`:
   ```ts
   if (effective && preferredFormat === 'pdf' && !effective.toLowerCase().endsWith('.pdf')) {
     effective = `${effective.replace(/\.[^.]+$/, '')}.pdf`;
   }
   ```
3. O backend serve o ficheiro derivado em PDF oficial (`pdfKey`) com cabeçalhos RFC 5987 seguros (`Content-Disposition: inline; filename="..."`).

### 3.6. Sincronização e Auto-Cura de Contas a Pagar
Arquivo: [`apps/api/src/modules/payments/payments.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/payments/payments.service.ts)

* Na listagem de Contas a Pagar (`listPayables`), a função `syncMissingDocumentPayables` analisa proativamente documentos com `dueDate`, `paymentDueDate` ou `total > 0`, gerando automaticamente os registos em falta em `PayableItem`.

---

## 4. Matriz de Testes e Validação

| Teste / Componente | Comando Executado | Resultado |
| :--- | :--- | :--- |
| **Classificador Fiscal** | `npm test -- fiscal-status.spec.ts` | **30/30 testes passaram** (100%) |
| **Documentos Service** | `npm test -- documents.service.spec.ts` | **47/47 testes passaram** (100%) |
| **Pagamentos Service** | `npm test -- payments.service.spec.ts` | **21/21 testes passaram** (100%) |
| **Compilação API NestJS** | `npm run build` (`apps/api`) | **Sucesso absoluto** (Exit code 0) |
| **Compilação Web Next.js**| `npx tsc --noEmit` (`apps/web`) | **0 erros de tipagem** (Exit code 0) |
| **Teste de API Remota** | `PATCH /api/v1/documents/cmu3a59o5004hp707c5687o1t` | **200 OK** — documento atualizado |
| **Verificação de Separadores** | `GET /api/v1/documents?type=ENCOMENDA` | **Não surge em encomendas** (OK) |
| **Verificação de Separadores** | `GET /api/v1/documents?excludeType=ENCOMENDA` | **Surge em Todas as Faturas** (OK) |
