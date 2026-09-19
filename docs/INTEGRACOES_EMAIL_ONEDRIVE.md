# DocFlow — Guia de Integração: Microsoft Graph (Email & OneDrive)

> **Caminho deste documento:** `C:\Projetos\docflow-mvp\docs\INTEGRACOES_EMAIL_ONEDRIVE.md`  
> **Data:** 14 de Setembro de 2026  
> **Estado:** Implementado e em Produção (Microsoft Graph Client Credentials, Inbound Multicanal, OneDrive)

---

## 1. Arquitetura e Configuração Real no Azure Entra ID

A integração com a Microsoft no DocFlow utiliza **permissões de aplicação (Application Permissions)** com consentimento de administrador (**Admin Consent**) através do fluxo **Client Credentials** OAuth 2.0.

> [!IMPORTANT]
> **Política de Canal Único (Single Channel Policy)**  
> Para evitar conexões duplicadas à mesma caixa de correio, o caminho interativo delegado (`authorization_code`) do Outlook está desativado. Toda a ingestão é efetuada pelo conector de serviço de fundo em [`OutlookService`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/outlook.service.ts). O Gmail encontra-se igualmente desativado por omissão (`GMAIL_ENABLED=false`).

### 1.1 Variáveis de Ambiente (Coolify / Produção)

| Variável | Valor Configurado | Descrição |
|---|---|---|
| `MS_TENANT_ID` | `f27c295b-2490-4101-9ae3-6db45ffd9489` | Tenant ID do Microsoft Entra ID (HotelEquip) |
| `MS_CLIENT_ID` | `0dcb16b8-3214-49c2-ab13-80c7e07fa332` | Application (client) ID da App registada |
| `MS_CLIENT_SECRET` | *(Segredo de cliente guardado no Coolify)* | Valor do segredo gerado no Azure |
| `MS_MAILBOX` | `financeiro@hotelequip.pt` | Endereço UPN da caixa de correio monitorizada |
| `MS_MAILBOX_ID` | `24bc1dc4-59ac-475d-9696-54a4b9327411` | ID interno de fallback da caixa |
| `MS_MAIL_FOLDER` | `Faturas` | Nome da pasta vigiada para novas faturas |
| `MS_MAIL_PROCESSED_FOLDER` | `Faturas/Processado` | Pasta de arquivo pós-processamento |
| `ONEDRIVE_ENTRADA_FOLDER` | `/DocFlow/Entrada` | Pasta de entrada no OneDrive empresarial |
| `ONEDRIVE_PROCESSADOS_FOLDER`| `/DocFlow/Processados` | Pasta de arquivo no OneDrive pós-ingestão |

### 1.2 Restrição de Segurança: ApplicationAccessPolicy

A aplicação no Azure está restringida por uma **ApplicationAccessPolicy** do Exchange Online.
- A aplicação **só tem autorização para aceder à caixa** `financeiro@hotelequip.pt`.
- Qualquer tentativa de aceder a outras caixas de correio do domínio devolverá `403 Forbidden` diretamente da API da Microsoft (comportamento esperado e salvaguarda de privacidade da organização).

---

## 2. Fluxo de Ingestão de Email (`financeiro@hotelequip.pt`)

O serviço [`OutlookService`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/outlook.service.ts) é executado automaticamente em segundo plano a cada 2 minutos pelo [`PollerService`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/poller.service.ts).

```
[Fornecedor / Reencaminhado]
          │
          ▼
financeiro@hotelequip.pt / Pasta: Faturas
          │
          ▼ (Poller 2m com Client Credentials)
1. Deteta emails não lidos (isRead eq false)
2. Expansão recursiva de itemAttachment (P0.1, RFC822)
   - Preserva remetente original, assunto original e mailbox de entrada
3. Download dos anexos (PDF, JPG, PNG, DOCX, HEIC)
4. Deteção de links de download no corpo (Moloni, TOConline, etc.)
   - Não descarrega links automaticamente; marca para revisão humana
5. Ingestão no /api/v1/inbound com proveniência e hash SHA-256
6. Pós-processamento no Graph:
   - Marca email como lido (isRead: true)
   - Move mensagem para Faturas/Processado
```

### 2.1 Reencaminhamento de Emails (`itemAttachment` / P0.1)
Quando a equipa interna reencaminha um email de fornecedor (de `geral@hotelequip.pt`, `apoio.cliente@`, etc.) como anexo de mensagem (`#microsoft.graph.itemAttachment` ou `message/rfc822`):
- O DocFlow expande recursivamente a mensagem original até encontrar os ficheiros PDF/imagem.
- Cada anexo origina **um documento independente** no DocFlow.
- Os metadados retêm a proveniência original: `originalSender` (email do fornecedor original), `originalSubject`, `originalDate` e `originalMailbox`.

---

## 3. Fluxo de Ingestão OneDrive (`/DocFlow/Entrada`)

O mesmo token de aplicação Microsoft Graph é utilizado para monitorizar a pasta de partilha no OneDrive empresarial:

1. **Pasta de Entrada:** `/DocFlow/Entrada`
   - O fornecedor ou colaborador deposita faturas ou recibos diretamente nesta pasta.
2. **Download e Deduplicação:**
   - O DocFlow lê os ficheiros suportados e faz o download.
   - Os ficheiros entram no pipeline com `origin: ONEDRIVE`.
   - O cálculo do hash SHA-256 impede documentos duplicados.
3. **Arquivo Automático:**
   - Logo após a ingestão com sucesso, o ficheiro é movido via Graph API para `/DocFlow/Processados`.

---

## 4. Classificação e Segregação de Encomendas de Clientes (P0.2)

Ao convergir no motor de extração IA e validação fiscal:
- Se o **NIF do emitente/fornecedor coincidir com o NIF da própria empresa (`515208566`)**:
  - O documento é classificado deterministicamente com `fiscalStatus: 'NAO_APLICAVEL'` e tipo `ENCOMENDA` ou `FATURA_EMITIDA`.
  - **Fica isolado do circuito de compras e do apuramento de IVA a deduzir**.
  - Não aparece na lista padrão de compras da inbox.
  - É consultável no separador dedicado **"Encomendas Cliente"** na interface web.
  - Entra no estado inicial `NOVO` / `PENDENTE` e **nunca é aprovado automaticamente**.

---

## 5. Resumo dos Ficheiros de Código

| Componente | Ficheiro | Descrição |
|---|---|---|
| **Serviço Graph / Outlook** | [`apps/api/src/modules/email-inbound/outlook.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/outlook.service.ts) | Implementação Client Credentials, `Faturas`, `itemAttachment`, `OneDrive` e desativação do caminho delegado |
| **Re-exportação Compatível** | [`apps/api/src/modules/email-inbound/microsoft-graph.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/microsoft-graph.service.ts) | Exportação de compatibilidade para `MicrosoftGraphService` |
| **Poller em Background** | [`apps/api/src/modules/email-inbound/poller.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/email-inbound/poller.service.ts) | Cron a cada 2 minutos |
| **Controlador de Inbound** | [`apps/api/src/modules/inbound/inbound.controller.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/inbound/inbound.controller.ts) | Endpoint unificado `/api/v1/inbound`, webhook WhatsApp e status |
| **Classificador Fiscal** | [`apps/api/src/modules/extraction/fiscal-status.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/extraction/fiscal-status.ts) | Atribuição de `NAO_APLICAVEL` para NIF da própria empresa |
| **Filtro de Documentos** | [`apps/api/src/modules/documents/documents.service.ts`](file:///C:/Projetos/docflow-mvp/apps/api/src/modules/documents/documents.service.ts) | Isolamento de `NAO_APLICAVEL` nas listagens padrão |
| **Separadores Frontend** | [`apps/web/app/(dashboard)/documents/_components/inbox-tabs.tsx`](file:///C:/Projetos/docflow-mvp/apps/web/app/%28dashboard%29/documents/_components/inbox-tabs.tsx) | Abas PDF, Scanner, Email, OneDrive, WhatsApp e Encomendas Cliente |
| **Tabela de Documentos** | [`apps/web/app/(dashboard)/documents/_components/document-table.tsx`](file:///C:/Projetos/docflow-mvp/apps/web/app/%28dashboard%29/documents/_components/document-table.tsx) | Badges de canal com tooltip de proveniência e badge Encomenda Cliente |
