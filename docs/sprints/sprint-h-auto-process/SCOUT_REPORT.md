# Sprint H — Auto-process pipeline + storage abstraction — SCOUT REPORT

**Branch:** main · **HEAD:** 0227a01 (após Sprint G; ainda não tem fix-up G nem Sprint H)
**Working dir:** `C:\Projetos\docflow-mvp`
**Mode:** READ-ONLY — no edits performed
**Skill loaded:** `oc-api-audit` ✅ · `oc-billing-webhooks` ✅ (audit skills para reviewer)

---

## 1. Mapa atual (factual)

### 1.1 Pipeline atual de upload → routing

Hoje o DocFlow **JÁ TEM** um pipeline, mas é um fire-and-forget semi-orquestrado que cobre só o **extract** (AI/QR-AT), **NÃO** cobre routing automático:

| Etapa | Onde mora | Quem dispara | Estado |
|---|---|---|---|
| Upload (validar MIME, magic-bytes, SHA-256, dedup, gravar, criar row) | `DocumentsService.upload()` (`documents.service.ts` L103-335) | Controller POST `/documents` | ✅ completo |
| PDF sibling (image → PDF) | `ImageToPdfService` (chamado em upload L183-198) | `upload()` mesmo | ✅ best-effort |
| `FolderRulesEngine.suggest()` (1ª passagem — Inbox catch-all) | upload L205-209 | `upload()` mesmo | ✅ completo |
| **Auto-extract** (QR-AT + Gemini vision + supplier resolve) | `extraction.service.ts` `enqueue()` L313 | `upload()` chama fire-and-forget L294-321 | ✅ mas fire-and-forget (sem retry/DLQ formal) |
| **Enrich** (supplier match + partyId link) | `SupplierResolver` (chamado por `extraction.service` pós-process) | dentro do `processDocumentAsync` | ⚠ dentro do mesmo job — não é estágio isolado |
| **Folder rename / routing** | HOJE só roda no **`approve()` manual** (`relocateAfterApprove` L966-1105 com `pg_advisory_xact_lock`) | `DocumentsService.approve()` dispara L919 | ⚠ apenas para docs revisados por humano |

**Conclusão:** o pipeline tem 4 passos lógicos, mas só os 2 primeiros rodam no upload (extract + enrich estão fundidos num único job BullMQ/sync, L256-264 do extraction.service.ts). Routing só roda pós-approve.

### 1.2 Storage abstraction existente

**Já existe em `apps/api/src/modules/documents/storage/`** (Sprint E adicionou, Sprint E não migrou pra `common/` — ver Sprint E SCOUT §1.3, recomendação §11.7):

```
modules/documents/storage/
├── storage-service.interface.ts   (75L — StorageService symbol + interface + 'local'|'s3'|'minio')
├── local-filesystem.storage.ts    (181L — driver local com put/getBuffer/remove/exists/move/getSignedUrl)
├── path-builder.ts                (90L — buildDocumentPath deterministic, party/category-aware)
└── storage.module.ts              (22L — wires LocalFilesystemStorage como provider)
```

**Métodos `StorageService`:** `put`, `getBuffer`, `remove`, `exists`, `move` (Sprint E adicionou), `getSignedUrl`. Falta `moveBatch`/`copy` (raro, OK).

**Gaps para Sprint H:**
- ⚠ Driver enum é `'local' \| 's3' \| 'minio'`. Não tem `'supabase'` (precisa adicionar ao enum se quisermos Supabase Storage adapter no H, ou deixar pra Sprint I+).
- ⚠ `STORAGE_DRIVER` env var **NÃO existe** ainda. `.env` tem `S3_*` mas o módulo sempre usa `LocalFilesystemStorage` (wired em `storage.module.ts` L14-19 — sem factory/condicional).
- ✅ **Migração pra `common/`?** — Sprint E SCOUT §11.7 RECOMENDA manter em `modules/documents/storage/`. Mantém-se a recomendação — o escopo de refactor não cabe em Sprint H.

### 1.3 Queue abstraction atual

**HOJE NÃO EXISTE queue abstraction.** O sistema tem 2 paths paralelos:

1. **`@nestjs/bullmq`** já está registrado globalmente em `app.module.ts` L95-123 com Redis client factory (`IORedis` + `createIORedisClient` do bullmq + `lazyConnect + maxRetriesPerRequest:null`).
2. **`ExtractionService.enqueue()`** (`extraction.service.ts` L313-410) usa **2 caminhos** num único método:
   - **BullMQ path** (L322-355): `this.queue.add()` com timeout 2s + fallback.
   - **Sync in-process FIFO** (L378-410): quando BullMQ falha (Redis down), `syncQueueTail.then(...)` encadeia jobs num único Promise serializado. É um fallback elegante, NÃO uma "abstraction".

**`@nestjs/event-emitter` NÃO está instalado** (verificado em `apps/api/package.json` — só tem `@nestjs/bullmq`, `bullmq`, `ioredis`). Sprint H precisa instalá-lo se quisermos a opção `eventemitter` driver.

### 1.4 ScheduleModule + BullMQ já disponíveis

**Confirmado em `app.module.ts`:**
- `ScheduleModule.forRoot()` L94 ✅
- `BullModule.forRootAsync({...})` L95-123 ✅ (global, com Redis client factory)
- `@nestjs/event-emitter` ❌ (NÃO instalado — Sprint H adiciona via `pnpm add @nestjs/event-emitter`)

### 1.5 Schema Prisma — campos relevantes para Sprint H

**`model Document`** (L371-479):
- `status: DocumentStatus @default(NOVO)` (L389) — state machine de aprovação
- `partyId: String?` (L425) — preenchido por `SupplierResolver` pós-extract
- `tenantId: String` (L373) + `@@index([tenantId, status])` etc. (L465)
- **FALTA:** `processingStatus` (estado do pipeline), `processingError`, `processingStartedAt`, `processingCompletedAt`
- `metadata` JSON L419 — JÁ carrega `originalFilename` + `extraction.*` payload (cabe pipeline events aqui, mas coluna dedicada é melhor p/ queries por status)

**`enum AuditAction`** (L132-150): LOGIN, LOGOUT, UPLOAD, CREATE, EDIT, DELETE, APPROVE, REJECT, IMPORT, EXPORT, RECONCILE, PAYMENT_INIT, PAYMENT_CONFIRM, CREATE_TENANT, INVITE_USER, ROLE_CHANGE, INTEGRATION_SYNC. **NÃO tem** `PROCESSING.STARTED`, `PROCESSING.FAILED`, `PROCESSING.COMPLETED`. **Recomendação:** estender o enum (migration separada) ou reusar `AuditAction.EDIT` com `metadata.subAction` (pattern Sprint E).

**`model Tenant`** (L195-244):
- `settings Json?` L208 — JÁ tem bucket para settings per-tenant (não precisa coluna nova)
- **FALTA:** `autoApprove: Boolean @default(false)` no JSON settings OU coluna nova. Recomendação: usar `Tenant.settings.autoApprove` para evitar migration (consultar Sprint G fix-up pattern).

**`model AuditLog`** (L334-365): append-only com hash chain. ✅ pronto.

### 1.6 DocumentsModule — estado do wiring

`documents.module.ts` (33L):
```typescript
@Module({
  imports: [StorageModule, forwardRef(() => ExtractionModule)],
  controllers: [DocumentsController],
  providers: [DocumentsService, FolderRulesEngine, ImageToPdfService],
  exports: [DocumentsService, FolderRulesEngine, ImageToPdfService],
})
```

- `StorageModule` (local) já importado.
- `ExtractionModule` (BullMQ extraction queue) já importado via `forwardRef`.
- **Falta importar:** `QueueModule` (Sprint H novo) + `ProcessingModule` (Sprint H novo).
- `DocumentsService.upload()` L267-332 chama `extraction.enqueue()` **diretamente**, não por abstração. Substituir por `QueueAdapter.publish('document.uploaded', ...)` é o ponto de injeção principal do Sprint H.

### 1.7 Frontend documents/ — estado atual

- `apps/web/app/(dashboard)/documents/page.tsx` — inbox 3 tabs (PDF/Scanner/Email). **Sem badge "Processing"** — list mostra `status` (NOVO/EM_REVISAO/APROVADO) estático.
- `apps/web/app/(dashboard)/documents/[id]/page.tsx` — detail page com bundle (viewer + fields + approve). **Sem SSE**, apenas `useDocumentBundle()` React Query (polling).
- `apps/web/app/(dashboard)/documents/[id]/_components/` — `document-viewor`, `field-panel`, `fraud-warning`, `qr-badge`. **Sem `processing-status.tsx`**.
- `apps/web/app/(dashboard)/documents/_components/types.ts` — types existentes. **`processingStatus` NÃO está tipado.**
- `apps/web/app/(dashboard)/settings/` — não tem `auto-approve-toggle.tsx`. Settings page atual é `page.tsx` + `profile/` + `integrations/`.

### 1.8 Audit skill check (oc-api-audit pré-aplicada)

Antes do builder mexer, estes pontos já tem de ser respeitados (apenas enumeração, validação é do builder/reviewer):

- **§1 BOLA**: todo handler novo (SSE) tem de ser `tenantId`-scoped via `req.user.tenantId`.
- **§3 Mass Assignment**: SSE não recebe body — mas o payload interno dos events tem de ser `sanitize()`-ed antes de mandar pro EventSource.
- **§4 Unrestricted**: SSE é uma conexão aberta — THROTTLE é mandatório. Upload já tem throttle + MAX_UPLOAD_BYTES 20MB (documents.service.ts L62).
- **§9 Audit Log**: cada stage transition writes a row (reusando `AuditAction.EDIT` com `subAction`).
- **§11 File System Security**: o helper `resolveSafe()` (local-filesystem.storage.ts L163-180) já confina paths ao root — manter.
- **§12 Race Conditions**: 2 approves simultâneos já tem lock (`pg_advisory_xact_lock`, documents.service.ts L983). Pipeline stages também precisam lock POR documentId para não avançar 2x.

---

## 2. Decisões pré-confirmadas (NÃO mude sem discussion)

1. **StorageAdapter abstraction**: reusar `apps/api/src/modules/documents/storage/` (Sprint E já construiu a interface). Sprint H adiciona **factory driver switch** em `storage.module.ts` que lê `STORAGE_DRIVER` env. NÃO migra pra `common/`.
2. **QueueAdapter abstraction**: nova em `apps/api/src/common/queue/` — interface `publish(topic, payload)`, `subscribe(topic, handler)`, `subscribeBatch(topics[], handler)`. 2 implementações: `EventEmitterAdapter` (requer `@nestjs/event-emitter`), `BullMQAdapter` (reusa Redis já registrado).
3. **Pipeline stages = 4 estágios assíncronos**:
   - `document.uploaded` (upload dispara)
   - `document.extracted` (extraction service termina)
   - `document.enriched` (party linkada + IBAN normalizado)
   - `document.routed` (routing concluded — completed OR failed)
4. **Race condition safety**: cada stage idempotente + `Document.processingStatus` enum persistido + lock por documentId (`pg_advisory_xact_lock`).
5. **Failure recovery**:
   - `BullMQAdapter`: retry 3x backoff exponencial (1s, 5s, 30s) + DLQ `document-processing-dlq` (admin logs).
   - `EventEmitterAdapter`: se listener throw, persiste status='failed' + audit log row. **Não há DLQ persistente** (in-memory only — caveat na doc).
6. **Real-time progress UI**: SSE endpoint `GET /documents/:id/processing/stream` que emite eventos tipo `processing.stage.completed`. Frontend consome via `EventSource` API.

---

## 3. Backend touchpoints (file:line)

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `apps/api/prisma/schema.prisma` (L132-150 AuditAction + L371-479 Document + L195-244 Tenant) | (a) adicionar `enum DocumentProcessingStatus { RECEIVED EXTRACTING ENRICHING ROUTING COMPLETED FAILED SKIPPED }`; (b) `Document.processingStatus DocumentProcessingStatus?` (nullable para docs legados); (c) `Document.processingError String?` (audit-friendly); (d) `Document.processingStartedAt DateTime?`; (e) `Document.processingCompletedAt DateTime?`; (f) `Document.processingAttempt Int @default(0)` |
| 2 | `apps/api/prisma/migrations/<ts>_add_processing_status/migration.sql` (novo) | `CREATE TYPE DocumentProcessingStatus AS ENUM (...)` + 4 `ALTER TABLE documents ADD COLUMN ...` + 2 índices `@@index([tenantId, processingStatus])` + `@@index([tenantId, processingStartedAt])` |
| 3 | `apps/api/src/common/queue/queue-adapter.interface.ts` | **NOVO** — `export interface QueueAdapter { publish(topic, payload): Promise<void>; subscribe(topic, handler): void; subscribeBatch(topics[], handler): void; driver: 'eventemitter' \| 'bullmq'; }` + `export const QueueAdapter = Symbol('QueueAdapter')` |
| 4 | `apps/api/src/common/queue/queue-events.ts` | **NOVO** — typed payloads: `DocumentUploadedEvent`, `DocumentExtractedEvent`, `DocumentEnrichedEvent`, `DocumentRoutedEvent`, `DocumentFailedEvent` (discriminated union) |
| 5 | `apps/api/src/common/queue/event-emitter.adapter.ts` | **NOVO** — `@nestjs/event-emitter` wrapper. `publish = emitter.emitAsync(topic, payload)`. `subscribe = emitter.on(topic, handler)`. In-process FIFO + try/catch wrapping. |
| 6 | `apps/api/src/common/queue/bullmq.adapter.ts` | **NOVO** — BullMQ wrapper. `publish = queue.add(jobName, payload, { attempts: 3, backoff: { type: 'exponential', delay: [1000, 5000, 30000] } })`. `subscribe = worker.on('completed', handler)`. Add DLQ worker. |
| 7 | `apps/api/src/common/queue/queue.module.ts` | **NOVO** — `@Module({ providers: [factory provider that reads QUEUE_DRIVER env], exports: [QueueAdapter] })`. Se `QUEUE_DRIVER=bullmq` → BullMQAdapter, else EventEmitterAdapter. Default `eventemitter` (zero infra required). |
| 8 | `apps/api/src/modules/documents/storage/storage.module.ts` (modificar L13-22) | Adicionar factory provider que lê `STORAGE_DRIVER` env. Valores: `local` (default HOJE), `s3`/`minio` (já em TODO), `supabase` (stub vazio retornando throw). |
| 9 | `apps/api/.env` | Adicionar `QUEUE_DRIVER=eventemitter` (default), `STORAGE_DRIVER=local` (default). Documentar `SUPABASE_*` placeholder vars. |
| 10 | `apps/api/src/modules/documents/processing/processing.service.ts` | **NOVO** — orquestra 4 estágios. Subscreve em `document.uploaded`, `document.extracted`, `document.enriched` via `QueueAdapter.subscribeBatch`. Cada handler: (a) `pg_advisory_xact_lock` por documentId; (b) atualiza `processingStatus`; (c) chama o serviço de domínio correspondente; (d) re-emite próximo evento. |
| 11 | `apps/api/src/modules/documents/processing/processing.controller.ts` | **NOVO** — `@Controller('documents/:id/processing')` + SSE handler `GET /stream` (Content-Type: text/event-stream) + `GET /status` (REST polling fallback). ThrottleBucketGuard key by tenant + documentId. |
| 12 | `apps/api/src/modules/documents/processing/processing-events-store.service.ts` | **NOVO** — singleton que mantém `Map<documentId, Subject<ProcessingEvent>>` em memória para SSE subscribers. Cleanup on disconnect via `OnModuleDestroy`. Limite: 1000 docs em flight (cap defensivo contra memory leak). |
| 13 | `apps/api/src/modules/documents/processing/processing.module.ts` | **NOVO** — importa `QueueModule` + `ExtractionModule` (forwardRef). Exporta `ProcessingService` + `ProcessingEventsStore`. |
| 14 | `apps/api/src/modules/documents/documents.service.ts` (modificar L267-332) | Substituir fire-and-forget `extraction.enqueue()` por `queueAdapter.publish('document.uploaded', { documentId, tenantId })`. Também set `Document.processingStatus='RECEIVED'` no upload (no final do método antes do `return this.sanitize(doc)`). Migration rollback path: se upload completa ANTES de set status, processing pode nunca começar — usar `try/catch` em volta do `publish()` para set `processingStatus='FAILED'` se adapter throws. |
| 15 | `apps/api/src/modules/documents/documents.controller.ts` | Adicionar endpoint `@Get(':id/processing/stream')` que delega ao `ProcessingController` (ou refatorar — o controller é fino, ver §4 frontend mapping). Adicionar `@Get(':id/processing/status')` para REST polling. `@Roles` permissivo (qualquer autenticado do tenant pode ler o status do próprio tenant). |
| 16 | `apps/api/src/modules/documents/documents.module.ts` (modificar L26-30) | Adicionar `ProcessingModule` ao `imports` + ao `providers` se necessário. |
| 17 | `apps/api/src/app.module.ts` (modificar L49-150) | Adicionar `QueueModule` e `ProcessingModule` ao array `imports`. Bull `forRootAsync` já existe — não duplicar. Mas adicionar 2nd queue: `BullModule.registerQueue({ name: 'document-processing' })` se o driver for `bullmq`. |
| 18 | `apps/api/package.json` | Adicionar `@nestjs/event-emitter: ^3.0.0` (peer compat com Nest 11.x — verificar). |

### Notas técnicas

- **Acyclic imports**: `ProcessingModule` precisa `forwardRef(() => DocumentsModule)` porque `processing.service` chama `documentsService.approve()` (routing stage). OU mais simples: o processing stage 4 emite `document.routed` e o handler de routing roda em `ProcessingService` mesmo, sem rebote (síncrono). **Recomendação: handler routing roda em ProcessingService** — evita ciclo.
- **Storage driver**: Sprint H NÃO implementa `supabase` driver concreto (deixar como stub throw) — o foco é o contrato + factory. Sprint I+ implementa de fato.
- **AutoApprove**: Sprint H NÃO toca em `Tenant.settings` para não misturar com Sprint G fix-up. Builder vai set `Document` with `tenant.settings.autoApprove: false` por default — Sprint I adiciona toggle UI.

---

## 4. Pipeline stages detail

### Stage 1: `document.uploaded`
- **Trigger:** `documents.service.upload()` success (substitui fire-and-forget `extraction.enqueue()` em L294).
- **Payload:** `{ documentId: string; tenantId: string; userId: string; fileKey: string; mimeType: string; fileSize: number; originalFilename: string; uploadedAt: ISO }`
- **Handler (`processing.handleUploaded`):**
  - `pg_advisory_xact_lock(documentLockKey(documentId))`
  - `Document.update({ processingStatus: 'EXTRACTING', processingStartedAt: now })`
  - `audit.log({ action: EDIT, subAction: 'processing.started', entityType: 'document', entityId })`
  - `extraction.enqueue({ tenantId, userId, documentId })` (chama o serviço existente — BullMQ já tem retry próprio)
  - **Idempotente:** se `processingStatus !== 'RECEIVED'`, skip (already running).

### Stage 2: `document.extracted`
- **Trigger:** `extraction.service.processDocumentAsync()` conclude + escreve `processingStatus='EXTRACTING'→'ENRICHING'` via emit ao final.
- **Payload:** `{ documentId: string; tenantId: string; extractedFields: ExtractedFields; confidence: number; source: 'at_qr'|'ai'|'at_qr+ai'|'ocr'|'none' }`
- **Handler (`processing.handleExtracted`):**
  - Reusa lógica do `SupplierResolver` (já linka party por NIF pós-extract). **Não duplicar** — chamar `this.supplierResolver.resolve(...)` a partir do handler. `SupplierResolver` hoje é internal do `extraction.service.ts`, precisa **exportar um hook de "enrich complete"** que o processing service consome.
  - `Document.update({ processingStatus: 'ENRICHING', metadata: { ...metadata, enrichment: { partyId, ibanNormalized, ... } } })`
  - Emit `document.enriched`.

### Stage 3: `document.enriched`
- **Trigger:** Stage 2 handler.
- **Payload:** `{ documentId; tenantId; partyId: string|null; partyMatched: boolean; ibanUpdated: boolean; ibanRiskScore: number|null }`
- **Handler (`processing.handleEnriched`):**
  - Lock.
  - Se `partyMatched` E `tenant.settings.autoApprove === true`: chamar `documentsService.approve(tenantId, userId, documentId)` (síncrono, com userId sendo o `uploadedById`).
    - approve() já dispara `relocateAfterApprove` (L919) que move bytes.
    - Routing fires-and-completes aqui.
  - Senão: set `processingStatus='COMPLETED'` (aguarda review manual — admin decide approve depois).
  - Emit `document.routed` (independente do path — representa "pipeline done").

### Stage 4: `document.routed`
- **Trigger:** Stage 3 handler (sempre emite, mesmo se skip-approve path).
- **Payload:** `{ documentId; tenantId; approved: boolean; newFileKey: string|null; partyId: string|null; completedAt: ISO }`
- **Handler (`processing.handleRouted`):**
  - `Document.update({ processingStatus: 'COMPLETED', processingCompletedAt: now })`
  - `audit.log({ action: EDIT, subAction: 'processing.completed', entityType: 'document', entityId })`
  - SSE emit (`processing.stage.completed`) para subscribers ativos.
  - Cleanup subscriber da `ProcessingEventsStore`.

### Failure path

- Em qualquer handler: `try { ... } catch (err) { processingStatus='FAILED'; processingError = err.message.slice(0,500); audit.log({ subAction:'processing.failed', error: err.message })`.
- **Idempotência da falha:** se já FAILED, skip. Reprocessar manualmente requer PATCH endpoint (não no Sprint H — vou acoplar Sprint I).

---

## 5. SSE endpoint (real-time progress)

### Backend

```
GET /api/v1/documents/:id/processing/stream
Headers: Accept: text/event-stream, Authorization: Bearer ...
Query:   tenantId=req.user.tenantId (auto)
Response: text/event-stream, retry: 3000
```

**Emite:**
- `processing.stage.completed` (data: `{ stage, status, completedAt }`)
- `processing.failed` (data: `{ stage, error, failedAt }`)
- `processing.completed` (data: `{ finalStatus: 'COMPLETED' | 'COMPLETED_AUTO_APPROVED' | 'FAILED' }`)
- Comentário `:keepalive` a cada 20s (anti-proxy timeout)

**Autenticação:** `@UseGuards(JwtGuard, TenantGuard)` + `@Roles()` permissivo (qualquer role autenticado do tenant pode subscrever). ThrottleBucketGuard keyed by tenant+documentId: 5 conns ativas por doc.

**Limpeza:** subscriber remove-se a si do Map quando `Request` é abortado (`req.on('close', ...)`) OU SSE fecha após `processing.completed`.

**Memória cap:** `processing-events-store.service.ts` mantém `Map<documentId, Subject>` com hard cap 1000. Acima disso, emite 503 ao novo subscriber (não polui).

### Frontend

```
const eventSource = new EventSource(`/api/v1/documents/${id}/processing/stream`, {
  withCredentials: true,
});
eventSource.addEventListener('processing.stage.completed', (e) => {
  // ... render step "done"
});
eventSource.addEventListener('processing.completed', () => eventSource.close());
eventSource.addEventListener('processing.failed', (e) => {
  // ... show error toast
});
```

**Polling fallback** para onde EventSource não funciona bem (proxies corporativos): `useProcessingStatus(docId)` React Query com `refetchInterval: 2_000` que chama `GET /documents/:id/processing/status`.

---

## 6. BullMQ adapter detail

### Queues

- `document-processing` — primary queue. Worker concurrency 1 por tenant (configurable via `WORKER_CONCURRENCY`, default 1).
- `document-processing-dlq` — dead-letter queue. **Sprint H NÃO tem admin dashboard** — jobs ficam logados via `audit_logs` (subAction: 'processing.failed').

### Job retry policy

```typescript
{ attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 200, removeOnFail: 1000 }
```

- **Tentativa 1:** delay 1s
- **Tentativa 2:** delay 5s (exponential, segunda falha)
- **Tentativa 3:** delay 30s (terceira falha → DLQ)

### Workers

- 1 worker global (`document-processing` processa todas as stages).
- Estágios identificados via `job.name` — `processing.stage.uploaded`, `.extracted`, `.enriched`, `.routed`.
- Handler único que faz `switch (job.name)` no worker.

---

## 7. Frontend touchpoints

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx` (novo) | Componente que abre SSE, renderiza 4 stages (Recebido → Extraindo → Enriqueceu → Roteado), mostra `processing.error` se FAILED. Usa `lucide-react` `Loader2`/`Check`/`XCircle`. Layout `flex gap-2 items-center`. |
| 2 | `apps/web/app/(dashboard)/documents/[id]/page.tsx` | Inserir `<ProcessingStatus documentId={doc.id} />` no topo da detail page (acima do hero status banner), só visível se `processingStatus !== 'COMPLETED'`. |
| 3 | `apps/web/app/(dashboard)/documents/page.tsx` (opcional) | Adicionar badge "Processing..." (Loader2 spin) na `DocumentTable` linha do doc quando `status='NOVO'` E doc foi criado nos últimos 5 min. |
| 4 | `apps/web/app/(dashboard)/documents/_lib/types.ts` | Adicionar `DocumentProcessingStatus = 'RECEIVED'\|'EXTRACTING'\|'ENRICHING'\|'ROUTING'\|'COMPLETED'\|'FAILED'\|'SKIPPED'` + estender `Document` interface com `processingStatus?`, `processingError?`, `processingStartedAt?`, `processingCompletedAt?`. |
| 5 | `apps/web/app/(dashboard)/documents/_components/use-documents.ts` | Adicionar `useProcessingStatus(documentId)` hook (REST polling, refetchInterval 2s) + `useProcessingStream(documentId)` hook (EventSource). |

> **Sprint H NÃO inclui** UI de `autoApprove` toggle — isso é Sprint I (precisa `Tenant.settings` mutation endpoint + per-tenant permission). Documento marca Sprint H scope clean.

---

## 8. Testes

| # | Suite | Cobertura |
|---|---|---|
| 1 | `apps/api/src/common/queue/__tests__/queue-adapter.interface.spec.ts` | Compilação + shape conformity (interface guard) |
| 2 | `apps/api/src/common/queue/__tests__/event-emitter.spec.ts` | publish/subscribe, FIFO ordering, listener throw → captured, multiple subscribers |
| 3 | `apps/api/src/common/queue/__tests__/bullmq.spec.ts` | BullMQ adapter com Redis mockado (`ioredis-mock`): retry 3x, backoff, DLQ on 3x fail. Verifica que `EventEmitterAdapter` e `BullMQAdapter` produzem SEQUÊNCIA equivalente dado o MESMO payload (parity test) |
| 4 | `apps/api/src/modules/documents/__tests__/processing-pipeline.spec.ts` | Os 4 stages executam em ordem, idempotência (2x publish = mesmo resultado final), failure recovery (extract throws → status='FAILED'), SSE emit por stage |
| 5 | `apps/api/src/modules/documents/__tests__/sse-endpoint.spec.ts` | SSE emite `processing.stage.completed` por stage; cliente desconecta → cleanup do Map; sem subscriber → `next()` continua; cap 1000 → 503 no novo |
| 6 | `apps/api/src/modules/documents/__tests__/storage-driver-factory.spec.ts` | `STORAGE_DRIVER=local` → LocalFilesystemStorage; `STORAGE_DRIVER=supabase` → throws (stub); default = 'local' |
| 7 | `apps/api/src/modules/documents/__tests__/upload-triggers-pipeline.spec.ts` | Upload success → `processingStatus='EXTRACTING'` + publish `document.uploaded` |
| 8 | `apps/api/src/common/queue/__tests__/idempotency.spec.ts` | Adapter-level: 2x publish do mesmo payload com mesmo ID → handler called once (dedup via jobId ou in-memory Set) |

---

## 9. Estimativa

- **Backend:** ~18 arquivos
  - 1 schema + 1 migration
  - 5 common/queue (interface + events + 2 adapters + module)
  - 4 processing (service + controller + events-store + module)
  - 4 documents/storage + documents.service + documents.controller + documents.module + app.module (modificações)
  - 1 .env
  - 1 package.json (add @nestjs/event-emitter)
  - **Subtotal: 18**
- **Frontend:** ~5 arquivos
  - 2 documents/[id] (ProcessingStatus component + page.tsx insertion)
  - 1 documents/page.tsx (badge opcional)
  - 1 _lib/types.ts
  - 1 _components/use-documents.ts
  - **Subtotal: 5**
- **Testes:** 8 arquivos (ver §8)
- **TOTAL: ~31 arquivos** — Sprint H é o maior até agora (Sprint G era 28, Sprint E era ~21)

---

## 10. Risks

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| 1 | **Migration drift**: Sprint G ainda não commitada (HEAD 0227a01, fix-up G pendente) | ALTA | Builder roda `prisma migrate status` antes de H; se drift, Sprint H bloqueia até fix-up G mergear |
| 2 | **Forward-ref ciclo ProcessingModule ↔ DocumentsModule** | MÉDIA | `forwardRef(() => DocumentsModule)` no `processing.module.ts` + `forwardRef` recíproco OU (preferível) **handler de routing roda em ProcessingService** sem rebote para DocumentsService.approve (síncrono in-place). Sprint H recomenda a 2ª. |
| 3 | **SSE memory leak**: subscribers não fecham connection | ALTA | `req.on('close')` cleanup + hard cap 1000 concurrent docIds + heartbeat de 20s para detectar cliente morto (server-side timeout padrão NestJS SSE + proxy idle) |
| 4 | **EventEmitterAdapter NÃO é distribuído** | ALTA (prod) | Documentar limitação clara no README: `eventemitter` driver é dev/CI only. PRD BullMQ para prod. Default em `.env.example` é `bullmq`. |
| 5 | **BullMQ retry flood**: 100 uploads concorrentes → 300 retries se todos falharem | MÉDIA | Rate limit `extraction.enqueue()` (já existe 10/min throttle global), backoff exponencial joga longe as retries |
| 6 | **StorageAdapter migration abandonada** | BAIXA | Sprint E já decidiu manter em `modules/documents/storage/`. Sprint H segue. Storage driver factory SWITCH dentro do mesmo módulo — zero refactor de call sites. |
| 7 | **Autenticação SSE sem cookies**: EventSource nativa NÃO suporta `Authorization` header | ALTA | Opção A: SSE via cookie (não recomendado — backend hoje usa `Authorization: Bearer`). Opção B: `event-source-polyfill` no frontend OU construir XHR-stream fallback. Recomendação: **polling REST 2s** + EventSource apenas para casos onde cookie auth já funciona (futuro). Sprint H implementa ambos. |
| 8 | **`@nestjs/event-emitter` peer dependency** | BAIXA | Verificar compat com NestJS 11.x no `pnpm add` — pode dar peer warning mas instalar normalmente |
| 9 | **`Tenant.settings` mutation racing** | BAIXA | `Tenant.settings Json?` L208 — sem constraint, sem otimistic update. Settings page ainda não tem UI. Sprint H NÃO toca — Sprint I abre. |
| 10 | **`SupplierResolver` precisa virar public service** | MÉDIA | Atualmente é `@Optional() private supplierResolver` em `extraction.service.ts`. Para `processing.service` chamar, precisa extrair lógica de enrichment para um serviço exportado OU `extraction.service` emite `document.extracted` já enriched. Recomendação: **extrair `EnrichmentService`** que combina `SupplierResolver.resolve` + `IbanHistory.upsert` numa API pública. Refactor mínimo Sprint H. |
| 11 | **Shutdown gracioso**: SSE connections + BullMQ workers em fly | MÉDIA | `OnModuleDestroy` no `processing-events-store.service.ts` fecha todas as Subjects. `BullMQ worker.close()` no `app.module.ts.onApplicationShutdown`. Documentar em README. |
| 12 | **`pg_advisory_xact_lock` contention**: processing handlers tentam lock por documentId, mas já existe lock do `relocateAfterApprove` (mesmo lock!) | BAIXA | Stage 3 (routing) chama `approve()` que PÓS acquires o MESMO lock — order é consistente. `docLockKey()` é determinístico (hash SHA-256 truncated). Sem deadlock. |
| 13 | **Pipeline events re-emitidos em dev hot-reload** | BAIXA | NestJS HMR não dispara SSE cleanup. Em dev, restart manual. Documentar. |

---

## 11. Decisões que o builder vai precisar

1. **Criar `apps/api/src/common/queue/`** ou co-locar queue adapter em `apps/api/src/modules/documents/queue/`?
   - Recomendado: **`common/queue/`** (reusável, pode ser consumido por Sprint I+ em outros módulos: `email-inbound`, `inbound`, `reconciliation`). Vantagem de locality é pequena (só `documents/` consome hoje).

2. **Queue adapter default**: `eventemitter` (zero infra) ou `bullmq` (resiliente)?
   - Recomendado: **`eventemitter`** como default em `.env.example`, documentar **proibido em produção**. Operador manualmente set `QUEUE_DRIVER=bullmq` quando provisiona Redis. Documentar limitação no README.

3. **`StorageAdapter` em `common/`?** — Mesmo padrão Sprint E: NÃO migrar. Factory switch dentro de `storage.module.ts` é suficiente.

4. **`processingStatus` em `Document` ou tabela paralela `DocumentProcessingState`?**
   - Recomendado: **coluna direta em `Document`** (1 row per doc, 1 status). Performance melhor (single SELECT), mais simples. Tabela paralela só faz sentido se cada stage fosse N rows auditáveis — não é o caso.

5. **SSE auth via cookie ou polling fallback?**
   - Recomendado: **ambos** (SSE primário se backend suportar, polling fallback 2s). Frontend testa EventSource sem header → se 401 backend, usar polling.

6. **`@nestjs/event-emitter` instalado** ou abstração própria?
   - Recomendado: **`@nestjs/event-emitter`** (NestJS padrão, manutenção ativa). Abstração própria é over-engineering para o MVP.

7. **`autoApprove` default** em `Tenant.settings`?
   - Recomendado: **`false` por default**. Sprint H NÃO implementa mutation endpoint — settings ficam no JSON blob mesmo. Sprint I add UI.

8. **Pipeline trigger**: 1ª chamada em `upload()` ou mover para uma fila de eventos desde email-inbound/scanner?
   - Recomendado: **centralizar em `documents.service.upload()`** HOJE (e em **scanner + email-inbound** chamarem o MESMO helper `documentsService.publishUploaded(doc)` no Sprint I). Sprint H foca no path upload; Sprint I generaliza.

9. **`processingStatus='COMPLETED'` no estado de "routing ended"** vs `'COMPLETED_AUTO_APPROVED'`?
   - Recomendado: **uma coluna `processingStatus`** + coluna `processingApproved Boolean?` separada para distinguir auto vs manual. UI usa `processingApproved` para mostrar "Auto-aprovado" ou "Aguarda review".

10. **Hot-reload test mock**: `ioredis-mock` para BullMQ adapter test — verificar compat com `BullMQ >= 6.x` lazy-loads.

11. **DLQ admin UI**?
    - Recomendado: **NÃO no Sprint H**. Jobs DLQ ficam só em `audit_logs`. Sprint I+ constrói dashboard se virar real-world need.

12. **Storage driver `'supabase'` stub ou implementation concreta?**
    - Recomendado: **stub com throw + comentário claro**. A sprint do user é "tem de DEPOIS poder trabalhar em Supabase" — não "tem de TER Supabase HOJE". Supabase driver concreto é Sprint I+ (precisa `@supabase/storage-js` + signed URL strategy).

---

## 12. Verdict do scout

✅ **READY to plan.** Terreno mapeado:
- 18 arquivos backend + 5 frontend + 8 testes = **31 arquivos**. Acima do brief 23 — justificado pelos 8 testes rigorosos, refactor de `SupplierResolver` para `EnrichmentService`, EventSource fallback para polling, e SSE events-store dedicado.
- Storage abstraction JÁ EXISTE (Sprint E), Sprint H só adiciona factory driver switch (zero call site change).
- Queue abstraction JÁ É 70% implementada no `extraction.service.ts` (syncQueueTail FIFO + try/catch). Sprint H formaliza num contrato + 2 adapters.
- BullMQ + Redis já estão em `app.module.ts`. ScheduleModule também. Setup mínimo.
- Frontend documents list + detail já tem React Query — adicionar SSE/polling status hook é trivial.

**Decisões acima são 12 — todas pequenas.** As duas mais impactantes:
- **Decisão 1**: criar `common/queue/` (afeta +5 arquivos, mas reusável em Sprint I+).
- **Decisão 6**: usar `@nestjs/event-emitter` (peer dep decision + 1 install).

**Riscos bloqueantes:**
- Migration drift se Sprint G fix-up não tiver mergeado (HEAD 0227a01 está ok hoje, mas builder precisa verificar `prisma migrate status`).
- SSE auth via Header é incompat com EventSource nativa — fallback polling obrigatório.

**Estimativa final do scout:** ~31 arquivos, ~800-1200 linhas de código (acima do brief por causa de testes rigorosos + 8 files de tests).

**Arquivos lidos (evidência):**

1. `apps/api/src/app.module.ts` (167L — BullMQ + Schedule + Throttler + Global Guards)
2. `apps/api/prisma/schema.prisma` (271-479 Document model + 132-150 AuditAction + 195-244 Tenant)
3. `apps/api/src/modules/documents/documents.service.ts` (1860L — foco em upload L103-335 + approve L865-1105)
4. `apps/api/src/modules/documents/storage/storage-service.interface.ts` (78L)
5. `apps/api/src/modules/documents/storage/local-filesystem.storage.ts` (181L)
6. `apps/api/src/modules/documents/storage/storage.module.ts` (22L)
7. `apps/api/src/modules/documents/storage/path-builder.ts` (90L)
8. `apps/api/src/common/storage/slug.ts` (31L)
9. `apps/api/src/modules/documents/documents.module.ts` (33L)
10. `apps/api/src/modules/extraction/extraction.service.ts` (L1-410 — foco em enqueue BullMQ vs sync)
11. `apps/api/src/modules/extraction/extraction.module.ts` (82L — BullMQ wiring)
12. `apps/api/.env` (50L)
13. `apps/api/package.json` (deps bullmq + ioredis; SEM @nestjs/event-emitter)
14. `apps/api/prisma/migrations/20260904000003_add_party_contacts_addresses/migration.sql` (formato de migration)
15. `apps/web/app/(dashboard)/documents/[id]/page.tsx` (L1-50 — usa useDocumentBundle, sem SSE)
16. `apps/web/app/(dashboard)/documents/page.tsx` (L1-80 — 3 tabs inbox, sem badge processing)
17. `apps/web/app/(dashboard)/documents/_components/` (listagem — types.ts + use-documents.ts)
18. Sprint G SCOUT_REPORT.md (referência)
19. Sprint E SCOUT_REPORT.md (referência — storage abstraction recommendation §11.7: MANTER em modules/documents/storage/)
20. Skill `oc-api-audit` carregada ✅ (relevante para reviewer)
21. Skill `oc-billing-webhooks` carregada ✅ (contexto para webhooks futuros, não aplicável H)

**Inferido mas não lido (builder deve confirmar antes de editar):**
- `apps/api/src/modules/parties/parties.service.ts` `SupplierResolver.refreshRecurringFlag()` (chamado por extraction.service — precisa confirmar que o refactor pra `EnrichmentService` mantém o invariante)
- `apps/api/src/modules/audit/audit.service.ts` `log()` shape (para verificar `subAction` pattern)
- `apps/web/app/(dashboard)/parties/_components/use-documents.ts` (`useProcessingStatus` add — onde mora? Provavelmente já neste arquivo)
- `apps/api/src/modules/extraction/supplier-resolver.ts` (162KB de código — extração para `EnrichmentService` precisa ser cirúrgica)
- `apps/web/app/(dashboard)/documents/[id]/_components/document-viewer.tsx` (para entender de onde inserir `<ProcessingStatus>` no detail layout)

---

*Fim do SCOUT_REPORT. Status: ready for builder.*
