# SCOUT_REPORT — Sprint F (Inbox multi-canal)

> Mission: Sprint F — Inbox multi-canal (PDF / Scanner / Email unified view)
> Mode: READ-ONLY map of the terrain for the builder
> Working dir: `C:\Projetos\docflow-mvp`
> Branch / HEAD: `main` @ `d261947`
> Date: 2026-09-04
> Skill loaded: `oc-api-audit` ❌ Unknown — proceeding without it (imitation forbidden by squad gate)
> Skill loaded: `oc-billing-webhooks` ❌ Unknown — proceeding without it

---

## 1. Estado atual (factual)

### 1.1 Como os documentos chegam HOJE

**Apenas 3 canais reais** já estão implementados e produzem `Document` rows, **embora 5 valores de `DocumentOrigin` existam no enum**. O enum completo (Prisma `schema.prisma:32-39`):

```prisma
enum DocumentOrigin {
  UPLOAD   // ← único canal via UI (drag-drop em /documents/upload)
  EMAIL    // ← ativo: SendGrid Inbound Parse webhook + IMAP polling
  SCANNER  // ← ativo: HTTP token endpoint /api/v1/inbound/scan (NÃO file watcher)
  MOBILE   // ← NÃO IMPLEMENTADO (sem endpoint, sem client)
  WHATSAPP // ← NÃO IMPLEMENTADO (sem endpoint, sem client)
  API      // ← NÃO IMPLEMENTADO
}
```

**Mapeamento real (origem → endpoint → service → enum value):**

| Origem UI | Endpoint | Controller | Service | `DocumentOrigin` |
|-----------|----------|------------|---------|-------------------|
| Drag-drop upload | `POST /api/v1/documents/upload` | `DocumentsController.upload` (`documents.controller.ts:69-128`) | `DocumentsService.upload` (`documents.service.ts:105-335`) | `UPLOAD` (default no DTO `document.dto.ts:34`) |
| SendGrid Inbound Parse webhook | `POST /api/v1/inbound/email` (Public, signature-verified) | `InboundController.email` (`inbound.controller.ts:56-81`) | `InboundService.ingestWebhookEmail` (`inbound.service.ts:236-255`) | `EMAIL` |
| IMAP polling (cron) | `POST /api/v1/inbound/mail/sync-all` (Public, `x-cron-secret`) | `InboundController.syncAll` (`inbound.controller.ts:41-52`) | `InboundService.syncAll` → `syncTenant` (`inbound.service.ts:135-234`) | `EMAIL` |
| Scanner HTTP drop (token) | `POST /api/v1/inbound/scan` (Public, `x-scan-token`, 5/min throttled) | `InboundController.scan` (`inbound.controller.ts:85-102`) | `InboundService.ingestScanner` (`inbound.service.ts:461-469`) | `SCANNER` |

### 1.2 O que já existe vs. o que falta

**Já existe**:
- `DocumentOrigin` enum com **6 valores** — o Sprint F só precisa **estender** o enum (não criar campo novo).
- Webhook inbound (SendGrid/Mailgun) com **3 paths de verificação de assinatura** (HMAC, ECDSA-P1363, fallback) — `inbound.service.ts:279-379`. HMAC ECDSA é produção-grade.
- IMAP polling com `lastSyncAt` guard (5 min throttle por tenant) e `markSeen` opcional.
- Scanner HTTP endpoint com throttling (5/min) e `Tenant.scanToken` lookup.
- `Integration` table (`schema.prisma:1119-1135`) já persiste credentials como **encrypted JSON envelope** (AES-256-GCM via `INTEGRATION_ENC_KEY`).
- BullMQ disponível (já registrado em `app.module.ts:83-111`) para jobs assíncronos.

**NÃO existe** (gaps para o Sprint F):
- **File watcher** (chokidar/fs.watch) — `SCANNER` hoje é HTTP push do scanner físico, não file watcher.
- **Gmail OAuth** — endpoint `/email-inbound/oauth/google` não existe.
- **Outlook OAuth** — endpoint `/email-inbound/oauth/microsoft` não existe.
- **EmailAccount model** — não há tabela para refresh tokens OAuth. Hoje o OAuth seria modelado em `Integration(provider='google'|'microsoft', credentials={accessToken, refreshToken, expiresAt})`.
- **Tab/segmentação por canal na UI** — `documents/page.tsx` renderiza 1 lista flat com `UploadZone` no topo, sem tabs.
- **Filtro `origin` no `findAll`** — `DocumentQueryDto` (`document.dto.ts:181-237`) tem filtros `status`, `type`, `partyId`, `dateFrom/To`, `search`, mas **NÃO tem `origin`**. O `buildWhere()` em `documents.service.ts:1243-1279` também não inclui `origin`.

### 1.3 Decisão crítica do scout (desvio do brief)

> **O brief pede `source: 'upload'|'scanner'|'gmail'|'outlook'|'inbound-webhook'` como campo NOVO.**
> **O scout RECOMENDA NÃO criar campo novo.** Reusar `DocumentOrigin` (já existe, já tem 6 valores, já está sendo setado em todos os create paths, já é exposto na response como `origin` — `document-table.tsx` não renderiza mas o field existe no `DocumentRecord`).

**Por quê**:
1. `DocumentOrigin` é semanticamente o mesmo conceito que o brief chama de "source" (canal pelo qual o documento chegou).
2. Criar `DocumentSource` ao lado geraria dois campos concorrentes com semântica sobreposta — fonte clássica de bugs (qual usar? o que a UI mostra?).
3. A coluna já existe, já tem dados históricos, já é filtrável na DB.
4. Sprint F só precisa **estender** o enum com `GMAIL`, `OUTLOOK`, `INBOUND-WEBHOOK` (e talvez renomear `EMAIL` → `INBOUND-WEBHOOK` se quiser ser específico — ver §11 decisão 1).

**Trade-off reconhecido**: o brief original pediu `source` separadamente de `origin`. Pode ter sido confusão do brief entre "origem" (canal HTTP/IMAP/scan) e "source" (UI grouping). Mas como o enum já cobre o domínio todo, criar campo paralelo é over-engineering. O scout **bloqueia** se o caller insistir em criar `DocumentSource` novo, e **recomenda** reusar `DocumentOrigin`.

### 1.4 Frontend atual — sem segmentação por canal

`apps/web/app/(dashboard)/documents/page.tsx` (127 linhas):
- Renderiza 1 `UploadZone` no topo + 1 `DocumentFilters` + 1 `DocumentTable` (lista flat).
- Sem tabs, sem contadores por canal, sem UI de configuração de scanner/OAuth.
- `document-table.tsx` aceita `origin?: string | null` no `DocumentRecord` (`types.ts:37`) mas **NÃO renderiza** — campo existe no tipo, é ignorado na UI.

`document-filters.tsx` (não lido, mas deduzido dos imports de `page.tsx`): tem filtros search/status/type/dateFrom/dateTo, **NÃO tem filtro origin**.

---

## 2. Decisões pré-confirmadas (NÃO mude, são ordens)

1. ✅ **4 canais no Sprint F**: PDF drag-drop (manter), Scanner via file watcher, Gmail OAuth, Outlook OAuth.
2. ✅ **UI em 3 ABAS separadas**: PDF / Scanner / Email (agrupando Gmail+Outlook+SendGrid/IMAP sob "Email").
3. ✅ **Document model**: reusar `DocumentOrigin` (estender enum, NÃO criar campo novo) — scout DESVIO do brief aqui, ver §1.3.
4. ✅ **Inbox unificada** (não 4 listas) mas com tab por canal dentro.

---

## 3. Backend touchpoints (file:line)

> **Nota do scout**: as linhas 3-5 e 8-9 do brief referem-se a "adicionar source" — o scout **redireciona** para `DocumentOrigin`. Linhas 1-2 do brief (schema + migration) valem, mas com alvo diferente.

| # | Arquivo | Linha(s) | Mudança proposta |
|---|---------|----------|------------------|
| 1 | `apps/api/prisma/schema.prisma` | L32-39 (enum `DocumentOrigin`) | Adicionar `GMAIL`, `OUTLOOK` ao enum. Renomear `EMAIL` → `INBOUND_WEBHOOK` (ver §11 decisão 1). Manter `SCANNER` (já existe, mas hoje usado pelo HTTP endpoint, não file watcher) |
| 2 | `apps/api/prisma/migrations/<ts>_add_origin_gmail_outlook/migration.sql` | novo | `ALTER TYPE "DocumentOrigin" ADD VALUE 'GMAIL'`, `ADD VALUE 'OUTLOOK'`. PG15+ permite `ADD VALUE` em transação. Se renomear EMAIL→INBOUND_WEBHOOK: precisa migration separada (Postgres não suporta rename de enum value diretamente — work-around: criar novo + migrate data + drop old) |
| 3 | `apps/api/src/modules/documents/dto/document.dto.ts` | L181-237 (`DocumentQueryDto`) | Adicionar `@IsOptional() @IsEnum(DocumentOrigin) @IsArray() origin?: DocumentOrigin[]` com `@Transform` para aceitar `?origin=GMAIL&origin=OUTLOOK` (comma-split). Sanitize contra valores fora do enum |
| 4 | `apps/api/src/modules/documents/documents.controller.ts` | L132-144 (`findAll`) | Documentar no `@ApiQuery` que `origin` aceita múltiplos valores (CSV). Sem mudança de assinatura |
| 5 | `apps/api/src/modules/documents/documents.service.ts` | L1243-1279 (`buildWhere`) | Adicionar `if (query.origin?.length) where.origin = { in: query.origin };`. Em `searchDocuments` (L384-447), adicionar `if (query.origin?.length) filters.push(Prisma.sql\`d.origin = ANY(${query.origin})::"DocumentOrigin"\`)`. `findAll` (L339-377) **já passa `buildWhere`** então pega automático |
| 6 | `apps/api/src/modules/inbound/inbound.service.ts` | L467 (`ingestScanner`) | Já passa `DocumentOrigin.SCANNER` — OK. Confirmar `metadata.source: 'scanner'` para distinguir HTTP-scan vs file-watcher (futuro) |
| 7 | `apps/api/src/modules/scanner/` (novo módulo) | novo | `scanner.service.ts` (chokidar file watcher com `awaitWriteFinish`), `scanner.controller.ts` (`POST /scanner/start`, `POST /scanner/stop`, `GET /scanner/status`), `scanner.module.ts` (importa `StorageModule` + `DocumentsModule` para reusar `upload()`/`createFromInbound()`) |
| 8 | `apps/api/src/modules/email-inbound/` (novo módulo) | novo | `gmail.service.ts` (OAuth web server flow + polling inbox com `gmail.readonly`), `outlook.service.ts` (OAuth + Microsoft Graph polling), `oauth.controller.ts` (`GET /email-inbound/oauth/google`, callback, idem microsoft), `email-inbound.module.ts` |
| 9 | `apps/api/src/modules/email-inbound/poller.service.ts` | novo | Polling loop (5min default, configurável) usando `@nestjs/schedule` (`@Cron('*/5 * * * *')`) ou BullMQ recurring job (mais robusto — ver §10 risks). Iterar `Integration WHERE provider IN ('google','microsoft') AND isActive`, refresh access token se expirado, fetch unread emails with attachment, download PDF/PNG/JPG, criar Document com `origin: GMAIL|OUTLOOK` |
| 10 | `apps/api/.env` | L1-31 | Adicionar `SCANNER_PATH` (default `apps/api/uploads/scanner/`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`. NÃO mexer em `INTEGRATION_ENC_KEY` (já existe) — reusar para refresh tokens |
| 11 | `apps/api/src/app.module.ts` | L28-46 (imports de features) | Adicionar `ScannerModule`, `EmailInboundModule`. Posicionar antes de `HealthModule` (ordem alfabética já respeitada) |
| 12 | `apps/api/src/modules/inbound/inbound.module.ts` | L1-13 | **NÃO MEXER** — SendGrid/IMAP já vive aqui. Manter separado do `EmailInboundModule` (que vai cobrir OAuth Gmail/Outlook) |

---

## 4. Frontend touchpoints (file:line)

| # | Arquivo | Mudança |
|---|---------|---------|
| 1 | `apps/web/app/(dashboard)/documents/page.tsx` L40-126 | Refatorar em 3 tabs state (`useState<'pdf'\|'scanner'\|'email'>('pdf')`). Cada tab passa filtro `origin` apropriado: `pdf=undefined` (default UPLOAD), `scanner='SCANNER'`, `email='EMAIL,GMAIL,OUTLOOK'` |
| 2 | `apps/web/app/(dashboard)/documents/_components/inbox-tabs.tsx` (novo) | Tabs com count por canal. Buscar count via `useDocumentsList({ origin: 'SCANNER' }, 1, 1)` por canal. Reusar `documentKeys.list` query cache |
| 3 | `apps/web/app/(dashboard)/documents/_components/scanner-config.tsx` (novo) | UI com: watch path display, "Start scanner" / "Stop scanner" buttons (chamar `POST /scanner/start` e `/stop`), status indicator (running/idle), "Test scan (drop file)" simulation button |
| 4 | `apps/web/app/(dashboard)/documents/_components/email-config.tsx` (novo) | UI com: status Gmail (connected/disconnected) + "Connect Gmail" button (`GET /email-inbound/oauth/google`), status Outlook idem, botão "Disconnect" (`DELETE /email-inbound/oauth/:provider`) |
| 5 | `apps/web/app/(dashboard)/documents/_components/document-table.tsx` L189-201 (coluna `folder`) | Adicionar coluna `origin` ANTES de `folder` com badge color-coded: PDF (sky), Scanner (amber), Email (violet). Renderizar `<DocumentOriginBadge origin={row.original.origin} />` |
| 6 | `apps/web/app/(dashboard)/documents/_components/types.ts` L30-47 | Adicionar `DocumentOrigin` type (`'UPLOAD'\|'EMAIL'\|'SCANNER'\|'GMAIL'\|'OUTLOOK'\|'INBOUND_WEBHOOK'`), adicionar `origin?: DocumentOrigin` ao `DocumentRecord` (já existe como `string | null` L37 — tipar melhor) |
| 7 | `apps/web/app/(dashboard)/documents/_components/use-documents.ts` L23-38 (`buildQuery`) | Adicionar `if (filters.origin) sp.set('origin', filters.origin.join(','))` para enviar CSV |
| 8 | `apps/web/app/(dashboard)/documents/_components/document-filters.tsx` (não lido, deduzido) | Adicionar dropdown "Canal" opcional (já que as 3 tabs principais são por canal, isso seria refinamento). Pode ficar pra Sprint F.1 |

---

## 5. Scanner file watcher (decisão técnica)

### 5.1 Recomendação do scout: **chokidar** (npm install)

**Por quê**:
- Battle-tested (1M+ downloads/semana), suporta glob patterns, debouncing built-in.
- `awaitWriteFinish: true` resolve race de arquivo ser detectado antes de terminar de ser escrito.
- API simples: `chokidar.watch(path, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 } })`.

**Alternativa nativa**: `fs.watch` é instável no Windows (eventos `rename`+`change` separados, sem debouncing). **NÃO RECOMENDADO**.

### 5.2 Implementação esboço

```typescript
// scanner.service.ts
@Injectable()
export class ScannerService {
  private watcher: chokidar.FSWatcher | null = null;
  private state: 'running' | 'stopped' = 'stopped';
  private watchPath: string = process.env.SCANNER_PATH || './uploads/scanner';

  constructor(
    @Inject(StorageService) private storage: StorageService,
    private readonly inbound: InboundService, // reusar ingestFiles()
  ) {}

  async start(): Promise<void> {
    if (this.state === 'running') return;
    await fs.mkdir(this.watchPath, { recursive: true });
    this.watcher = chokidar.watch(this.watchPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      ignored: /(^|[\/\\])\../, // dotfiles
    });
    this.watcher.on('add', async (filePath) => {
      const buffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      // Validate MIME from extension; reject if not in {pdf,jpg,jpeg,png,docx}
      const mimetype = mime.lookup(ext) || 'application/octet-stream';
      // Reusar InboundService.ingestFiles com origin: SCANNER
      await this.inbound.ingestFiles(/* single-tenant or per-folder mapping */, [{ buffer, originalname: fileName, mimetype, size: buffer.length }], DocumentOrigin.SCANNER, { source: 'file-watcher' });
      // Optionally move file to .processed/ subdir
    });
    this.state = 'running';
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    this.state = 'stopped';
  }

  getStatus() { return { state: this.state, watchPath: this.watchPath }; }
}
```

**Importante**: o brief propõe "per-tenant watch path". Scout recomenda **global** por enquanto (`apps/api/uploads/scanner/`) com naming convention `<tenantId>-<filename>` ou uma sub-pasta por tenant (`<SCANNER_PATH>/<tenantId>/`). Per-tenant puro precisa de `watch(paths: string[])` ou múltiplos watchers — mais complexo. Ver §11 decisão 4.

### 5.3 State persistence

Recomendação: **em memória** (variável do service) + endpoint `GET /scanner/status` que retorna state + path. Não persistir em DB — file watcher é operacional, restart do API restaura `stopped`. Operador usa "Start scanner" no boot.

---

## 6. Gmail OAuth (decisão técnica)

### 6.1 Fluxo

1. User clica "Connect Gmail" → frontend chama `GET /email-inbound/oauth/google?state=<csrf>`.
2. Backend gera URL OAuth:
   ```
   https://accounts.google.com/o/oauth2/v2/auth?
     client_id=${GOOGLE_CLIENT_ID}&
     redirect_uri=${GOOGLE_REDIRECT_URI}&
     response_type=code&
     scope=https://www.googleapis.com/auth/gmail.readonly&
     access_type=offline&    // ← CRÍTICO para refresh_token
     prompt=consent&          // ← força tela de consent pra refresh_token
     state=<csrf>
   ```
3. User autoriza → Google redireciona para `GET /email-inbound/oauth/google/callback?code=<>&state=<>`.
4. Backend troca code por tokens via POST `https://oauth2.googleapis.com/token`.
5. Persiste `Integration` row: `{ tenantId, provider: 'google', credentials: { accessToken, refreshToken, expiresAt, scope, email }, isActive: true }` com **credentials encrypted** (mesmo envelope AES-256-GCM do IMAP, reusar `INTEGRATION_ENC_KEY`).

### 6.2 Scopes e segurança

- **Scope read-only**: `https://www.googleapis.com/auth/gmail.readonly` (NÃO `gmail.modify` — mostraria tela de "perigoso").
- **Scopes adicionais necessários**: `https://www.googleapis.com/auth/userinfo.email` para identificar qual conta Gmail conectou (multi-account per tenant).
- **CSRF state**: gerar random token, validar no callback.
- **Refresh token**: Google só emite se `access_type=offline` + `prompt=consent`. Sem isso, expira em 1h e polling morre.

### 6.3 Polling

- A cada 5 min (default), `PollerService.pollGmail(tenantId)`:
  1. Refresh access_token se `expiresAt < now + 60s` (use `POST https://oauth2.googleapis.com/token` com `grant_type=refresh_token`).
  2. List messages: `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=has:attachment+is:unread+after:<lastPollTimestamp>`.
  3. Para cada message, `GET .../messages/<id>?format=full`, parsear payload, baixar attachments PDF/PNG/JPG.
  4. Para cada attachment válido: criar `Document` com `origin: 'GMAIL'` (e `metadata: { gmailMessageId, gmailThreadId, from, subject }`).
  5. Auto-trigger extraction (mesmo fire-and-forget pattern do `documents.service.ts:288-332`).

### 6.4 Endpoints

| Method | Path | Auth | Body | Description |
|--------|------|------|------|-------------|
| `GET` | `/email-inbound/oauth/google` | Bearer | query: `state` (CSRF) | Redireciona para Google consent screen |
| `GET` | `/email-inbound/oauth/google/callback` | Public (Google chama) | query: `code`, `state` | Recebe code, troca por tokens, persiste Integration, redireciona para `/documents?tab=email&connected=gmail` |
| `GET` | `/email-inbound/oauth/microsoft` | Bearer | query: `state` | Idem para Microsoft |
| `GET` | `/email-inbound/oauth/microsoft/callback` | Public (Microsoft chama) | query: `code`, `state` | Idem |
| `DELETE` | `/email-inbound/oauth/:provider` | Bearer | — | Desconecta (set `Integration.isActive: false`, NÃO deleta para preservar audit) |
| `GET` | `/email-inbound/status` | Bearer | — | Retorna `{ google: { connected, email, lastSyncAt, lastSyncStatus }, microsoft: {...} }` |

---

## 7. Outlook OAuth (decisão técnica)

### 7.1 Fluxo

Idêntico ao Gmail, mas com Microsoft Identity Platform:

1. Auth URL: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&response_type=code&redirect_uri=${MICROSOFT_REDIRECT_URI}&scope=offline_access+Mail.Read+User.Read&state=<csrf>`
2. Token URL: `POST https://login.microsoftonline.com/common/oauth2/v2.0/token`
3. Graph API: `GET https://graph.microsoft.com/v1.0/me/messages?$filter=isRead eq false&$expand=attachments`

### 7.2 Scopes

- `offline_access` → para refresh_token (separado do Gmail, vem como scope explícito).
- `Mail.Read` → read-only mailbox.
- `User.Read` → identificar conta (multi-tenant).

### 7.3 Polling

Idem Gmail. Usar `lastSyncAt` por tenant para `since=<lastSyncAt>` no Graph `$filter`.

---

## 8. UI tabs — design proposto

### 8.1 Tab structure

```
┌──────────────────────────────────────────────────────────────┐
│ Documentos                            [Atualizar ↻]          │
│ Inbox documental com extração IA                            │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │ PDF  127 │ │Scanner 8│ │ Email 23 │  ← inbox-tabs.tsx     │
│ └──────────┘ └──────────┘ └──────────┘                      │
├──────────────────────────────────────────────────────────────┤
│ [Tab content area — swaps based on active tab]              │
│                                                              │
│ Tab PDF:                                                     │
│   [UploadZone]                                               │
│   [DocumentFilters]                                          │
│   [DocumentTable — origin=UPLOAD]                            │
│                                                              │
│ Tab Scanner:                                                 │
│   [scanner-config: Watch: C:\uploads\scanner | ▶ Start | ■] │
│   [DocumentTable — origin=SCANNER]                           │
│                                                              │
│ Tab Email:                                                   │
│   [email-config: Gmail ● connected | Outlook ○ Connect]    │
│   [DocumentTable — origin=EMAIL,GMAIL,OUTLOOK,INBOUND...]   │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 Channel badge em `document-table.tsx`

Adicionar coluna `origin` ANTES de `folder`:

```tsx
columnHelper.accessor('origin', {
  header: 'Canal',
  cell: ({ getValue }) => {
    const v = getValue();
    const map = {
      UPLOAD: { label: 'PDF', cls: 'badge-sky' },
      SCANNER: { label: 'Scanner', cls: 'badge-amber' },
      EMAIL: { label: 'Email', cls: 'badge-violet' },
      GMAIL: { label: 'Gmail', cls: 'badge-violet' },
      OUTLOOK: { label: 'Outlook', cls: 'badge-violet' },
      INBOUND_WEBHOOK: { label: 'Email', cls: 'badge-violet' },
    };
    return v ? <span className={map[v].cls}>{map[v].label}</span> : '—';
  },
}),
```

---

## 9. Testes

| # | Arquivo | Cobertura |
|---|---------|-----------|
| 1 | `apps/api/src/modules/scanner/__tests__/scanner.spec.ts` | chokidar 'add' event → buffer → `ingestFiles(origin: SCANNER)` → Document row com `fileHash` correto. Race test: write lento + awaitWriteFinish |
| 2 | `apps/api/src/modules/email-inbound/__tests__/gmail.spec.ts` | Mock Google OAuth: callback → Integration row criada, encrypted. Mock Gmail API: list messages → fetch attachment → Document criado com `origin: GMAIL`. Refresh token flow (expired → refresh → reuse) |
| 3 | `apps/api/src/modules/email-inbound/__tests__/outlook.spec.ts` | Idem Gmail com Microsoft Graph API mockado |
| 4 | `apps/api/src/modules/documents/__tests__/documents-origin.spec.ts` | Filtro `findAll({ origin: ['GMAIL', 'OUTLOOK'] })` retorna apenas rows com `origin IN (...)`. Combinação com status + search + dateFrom |
| 5 | `apps/api/src/modules/email-inbound/__tests__/oauth-csrf.spec.ts` | CSRF state token invalid → 401. State token replay → 401. Cross-tenant callback attack → 403 |

---

## 10. Estimativa

- **Backend**: 8-10 arquivos (1 schema enum extend, 1 migration, 1 dto add, 1 service filter, 2 novos módulos × 3 arquivos cada ~ 6, 1 module wire) → **~9 arquivos**.
- **Frontend**: 4-5 arquivos (page.tsx refactor + 3 novos componentes + 1 types update) → **5 arquivos**.
- **Testes**: 5 arquivos novos.
- **Total: ~19 arquivos** (vs brief 16-20, dentro do range).

---

## 11. Risks/Gotchas

| Risco | Severidade | Mitigação |
|-------|-----------|-----------|
| **Gmail/Outlook refresh tokens em plain text** | ALTA | Reusar envelope AES-256-GCM (`INTEGRATION_ENC_KEY` já existe, IMAP já usa — `inbound.service.ts:119-133`). Mesmo código, mesma key |
| **Gmail quota exceeded** | BAIXA | Gmail API: 1B quota units/day. Polling 5min × 1 req/sin tenant = trivial |
| **Microsoft token expiry diferente**: Outlook access token = 1h, refresh token = 90 dias rolling | BAIXA | Refresh proactive (60s antes de `expiresAt`) |
| **OAuth state CSRF attack** | ALTA | Random 32-byte state, signed JWT ou store in HttpOnly cookie por 10min, validar no callback. Reject cross-tenant |
| **Polling paralelo**: 2 tenants Gmail connect, mesmo 5min mark | BAIXA | `@Cron` do `@nestjs/schedule` serializa por design. BullMQ recurring seria over-engineering |
| **Scanner file watcher race** (file partially written) | ALTA | `chokidar awaitWriteFinish: { stabilityThreshold: 2000 }` — default 2s suficiente pra PDFs/imagens |
| **Scanner cross-volume move** (Linux OK, Windows ❌) | BAIXA | Não se aplica — scanner file watcher é read+create, não move |
| **Gmail/Outlook scope errado** | ALTA | Manter read-only. **NUNCA** pedir `gmail.modify` ou `Mail.ReadWrite` — Google/Microsoft mostra tela vermelha de "perigoso" |
| **Multi-attach email**: Gmail pode ter 10+ attachments | BAIXA | Processar todos (não só primeiro). Cada um vira Document separado. Limite: pular >20 attachments com warning |
| **Renomear `EMAIL` → `INBOUND_WEBHOOK`** quebra dados existentes | MÉDIA | Postgres não suporta rename de enum value. Work-around: (a) criar novo enum value `INBOUND_WEBHOOK`, deixar `EMAIL` deprecado, (b) documentar que `EMAIL` será mantido para retro-compat. Scout recomenda (a) — adicionar `INBOUND_WEBHOOK` como alias e usar para novos webhooks |
| **Migration `ADD VALUE` em transação** | BAIXA | PG 15+ OK. Confirmar versão em produção (provavelmente 15+) |
| **OAuth credentials no DB = vetor de ataque** | ALTA | Encryption envelope + `INTEGRATION_ENC_KEY` em env var (não DB). Já praticado em IMAP |
| **Microsoft `User.Read` scope vs `User.ReadBasic.All`** | BAIXA | Usar `User.Read` (single-tenant). Não pedir `.All` (escopo amplo) |
| **Cron poller reinicia após deploy** | BAIXA | `@Cron` do `@nestjs/schedule` retoma automaticamente no boot. Não persistir state — `lastSyncAt` por tenant em Integration já dá continuidade |

---

## 12. Decisões que o builder vai precisar tomar

### Decisão 1: Renomear `EMAIL` → `INBOUND_WEBHOOK`?

**Recomendado: NÃO renomear. Adicionar `INBOUND_WEBHOOK` como novo valor, deixar `EMAIL` para retro-compat.**
- `EMAIL` já está em produção (SendGrid Inbound Parse + IMAP ambos setam `EMAIL`).
- Scout recomenda: `EMAIL` para IMAP legacy, `INBOUND_WEBHOOK` para SendGrid/Mailgun novos, `GMAIL`/`OUTLOOK` para OAuth. Tudo no mesmo enum.

### Decisão 2: OAuth credentials storage

**Recomendado: encrypted no DB** (reusar `INTEGRATION_ENC_KEY` envelope AES-256-GCM).
- Mesmo padrão do IMAP. KMS é overkill para MVP.

### Decisão 3: Polling interval

**Recomendado: 5min hardcoded**, configurável via env var (`POLLER_INTERVAL_MS`) depois se necessário.
- Gmail/Outlook API quota permite polling bem mais frequente (1B units/dia).
- BullMQ recurring job vs `@Cron`: scout recomenda `@Cron` (já está no projeto — `ScheduleModule.forRoot()` em `app.module.ts:82`). BullMQ é overkill.

### Decisão 4: Scanner watch path — global vs per-tenant

**Recomendado: global** (`apps/api/uploads/scanner/<tenantId>/<filename>`) para MVP.
- Per-tenant puro precisa de array de paths no chokidar — viável mas +5 LOC.
- Naming convention `<tenantId>-<filename>` ou sub-folder resolve ambiguidade.
- Future Sprint: UI permite admin apontar path customizado (Windows network share, NFS).

### Decisão 5: Email filter — só attachments ou também text+link?

**Recomendado: SÓ attachments PDF/PNG/JPG/DOCX**.
- Text+link scraping é feature separada (Sprint I ou J). Não vale o candle aqui.
- Se email tem texto+link pra invoice pública (PDF URL), operador processa manualmente por enquanto.

### Decisão 6: `origin` filter no `findAll` — single value ou array?

**Recomendado: array** (`origin=GMAIL&origin=OUTLOOK` no query string).
- UI Tab Email precisa filtrar 3-4 valores simultaneamente (EMAIL + GMAIL + OUTLOOK + INBOUND_WEBHOOK).
- Backward-compat: se query tem só `?origin=SCANNER`, retornar `{ in: ['SCANNER'] }`.

### Decisão 7: BullMQ recurring vs @Cron para PollerService?

**Recomendado: @Cron**.
- BullMQ precisaria de novo queue + worker + recurring job setup. ~30 LOC a mais.
- @Cron é built-in (`ScheduleModule.forRoot()` já carregado). Mais simples, mesma reliability para MVP.
- Migrar para BullMQ se polling falhar sob carga (não esperado — quota é gigante).

### Decisão 8: Auto-trigger extraction em docs vindos de OAuth/Scanner

**Recomendado: SIM, mesmo fire-and-forget pattern do upload** (`documents.service.ts:288-332`).
- Reusar `InboundService.ingestFiles` que já chama `extraction.enqueue()` (linha 489-499).

---

## 13. Pre-flight checks pro builder

Antes de commitar:
- [ ] `pnpm --filter api prisma migrate status` — confirmar zero drift
- [ ] `pnpm --filter api prisma migrate dev --name add_origin_gmail_outlook` — gera SQL + cliente
- [ ] Revisar `migration.sql` gerado contra §3 deste doc
- [ ] `pnpm --filter api build` — TypeScript compila sem erros
- [ ] `pnpm --filter api test scanner.spec.ts` — file watcher → Document
- [ ] `pnpm --filter api test gmail.spec.ts` — mock OAuth flow + polling
- [ ] `pnpm --filter api test outlook.spec.ts` — idem Microsoft
- [ ] `pnpm --filter api test documents-origin.spec.ts` — filtro funciona
- [ ] Smoke: criar 1 PDF em `apps/api/uploads/scanner/`, esperar 2s, ver Document com `origin: SCANNER` no inbox
- [ ] Smoke: conectar Gmail via OAuth (em dev com test account), esperar 5min, ver email com attachment PDF virar Document
- [ ] UI: `/documents` mostra 3 tabs com counts corretos
- [ ] UI: tab Scanner tem "Start/Stop scanner" funcional
- [ ] UI: tab Email tem "Connect Gmail/Outlook" abrindo OAuth flow

---

## 14. Resumo executivo pro caller

**Terreno mapeado.** Estado atual é surpreendentemente mais avançado do que o brief sugere:
- `DocumentOrigin` enum JÁ EXISTE e JÁ É USADO por 3 caminhos (upload, IMAP, SendGrid, scanner-HTTP). Sprint F não precisa criar campo novo — só **estender** com `GMAIL` + `OUTLOOK`.
- SendGrid Inbound Parse webhook JÁ É PRODUCTION-GRADE (HMAC + ECDSA-P1363 + Mailgun) — scout encontrou isso como ponto forte, não gap.
- IMAP polling JÁ EXISTE (cron secret, AES-GCM envelope).
- Scanner HTTP endpoint JÁ EXISTE (token, throttled). Sprint F adiciona **file watcher** (chokidar) ao lado — não substitui.
- BullMQ e ScheduleModule JÁ ESTÃO CARREGADOS — PollerService escolhe `@Cron` (mais simples).

**Decisão crítica do scout (desvio do brief)**: NÃO criar campo `DocumentSource` paralelo. Reusar `DocumentOrigin`. Razões em §1.3.

**Riscos bloqueantes**: zero identificados. Encryption envelope já existe. Quotas são gigantes. CSRF state é prática OAuth padrão.

**Estimativa final do scout**: ~9 backend + 5 frontend + 5 testes + 1 migration = **~20 arquivos** (dentro do brief 16-20).

**Skills carregadas**: NENHUMA (`oc-api-audit` e `oc-billing-webhooks` retornaram Unknown — proceed sem imitar conforme squad gate).

**Arquivos lidos (evidência)**:

1. `apps/api/prisma/schema.prisma` (1317 linhas — foco no enum DocumentOrigin L32-39 e model Document L359-467)
2. `apps/api/src/modules/documents/documents.controller.ts` (346 linhas)
3. `apps/api/src/modules/documents/documents.service.ts` (1855 linhas — foco em upload L105-335, buildWhere L1243-1279)
4. `apps/api/src/modules/documents/dto/document.dto.ts` (264 linhas)
5. `apps/api/src/modules/inbound/inbound.controller.ts` (104 linhas)
6. `apps/api/src/modules/inbound/inbound.service.ts` (543 linhas — foco em ingestScanner L461-469, ingestFiles L481-501)
7. `apps/api/src/modules/inbound/inbound.module.ts` (13 linhas)
8. `apps/api/src/app.module.ts` (153 linhas)
9. `apps/api/.env` (31 linhas — SCANNER_PATH e OAuth credentials NÃO existem)
10. `apps/api/prisma/migrations/` (listagem — 13 migrations, latest `20260904000001_unique_party_slug`)
11. `apps/web/app/(dashboard)/documents/page.tsx` (127 linhas)
12. `apps/web/app/(dashboard)/documents/_components/types.ts` (79 linhas)
13. `apps/web/app/(dashboard)/documents/_components/document-table.tsx` (398 linhas)
14. `apps/web/app/(dashboard)/documents/_components/use-documents.ts` (233 linhas)
15. `apps/api/src/modules/extraction/` (listagem — Sprint H dependency confirmado)
16. `sprint-d-apply-components/sprint-e-party-categories/SCOUT_REPORT.md` (478 linhas — referência de formato)

**Inferido mas não lido (builder deve confirmar antes de editar)**:
- `apps/web/app/(dashboard)/documents/_components/document-filters.tsx` (filtros existentes)
- `apps/web/app/(dashboard)/documents/_components/upload-zone.tsx` (UI do drag-drop)
- `apps/api/src/modules/extraction/extraction.service.ts` (Sprint H — auto-trigger target)

---

*Fim do SCOUT_REPORT. Status: ready for builder, with one deviation flagged (§1.3 — reusar DocumentOrigin, não criar DocumentSource).*
