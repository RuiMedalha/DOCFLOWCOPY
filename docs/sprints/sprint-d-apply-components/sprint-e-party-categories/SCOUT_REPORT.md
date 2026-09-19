# SCOUT_REPORT — Sprint E (Party categories + folder routing)

> Mission: Sprint E — Party categories + folder routing local (FILESYSTEM, no Supabase yet)
> Mode: READ-ONLY map of the terrain for the builder
> Working dir: `C:\Projetos\docflow-mvp`
> Branch / HEAD: `main` @ `bfb3839`
> Date: 2026-09-04
> Skill loaded: `oc-storage-patterns` ✅

---

## 1. Estado atual (factual)

### 1.1 Onde os arquivos ficam AGORA

O DocFlow **já tem** um storage backend — só que ele NÃO segue o shape proposto em `oc-storage-patterns` (que propõe `<storage>/fornecedores/<slug>/<YYYY-MM>/...`). O shape atual foi escolhido para ser consistente com S3/MinIO (que já tem driver configurado), não para navegação humana de pastas.

**Path real** (`apps/api/uploads/<tenantId>/<yyyy>/<mm>/<timestamp>-<random>.<ext>`):

```
C:/Projetos/docflow-mvp/apps/api/uploads/cmtf1scz20000g5s0n621bzef/2026/09/
├── 1788303663292-cd9e3982578b005a.jpg
├── 1788303663292-cd9e3982578b005a.pdf
├── 1788304282522-13cbb1e2b2f4f8a6.pdf
├── ...
```

**Origem do path**: `DocumentsService.buildStorageKey()` em `apps/api/src/modules/documents/documents.service.ts:1351-1358`:

```typescript
private buildStorageKey(tenantId: string, fileName: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = this.extractExtension(fileName);
  return `${tenantId}/${yyyy}/${mm}/${Date.now()}-${crypto
    .randomBytes(8)
    .toString('hex')}${ext}`;
}
```

Root dir resolvido em `apps/api/src/modules/documents/storage/local-filesystem.storage.ts:33-37`:
- `UPLOADS_DIR` env var → default `path.resolve(process.cwd(), 'uploads')`
- Default real (cwd = `apps/api`): `apps/api/uploads/`

### 1.2 Como o upload chama o filesystem hoje

`DocumentsService.upload()` em `apps/api/src/modules/documents/documents.service.ts:103-331`:

1. Valida `ALLOWED_MIMES` (L52-59: PDF, JPEG, JPG, PNG, DOCX, DOC).
2. Valida magic-bytes via `assertMimeMatchesSignature()` (L129-139) — Sprint B hardening.
3. Calcula SHA-256 do buffer (L141).
4. **Dedup**: `findFirst({ where: { tenantId, fileHash } })` (L150-160) — retorna 409 se dup. Race coberta por `@@unique([tenantId, fileHash])` (schema L464).
5. **Build storage key**: `buildStorageKey(tenantId, originalname, now)` (L165) — gera o path atual.
6. **Write via storage abstraction**: `this.storage.put(fileKey, file.buffer, { contentType: file.mimetype })` (L170).
7. **PDF derivative**: para imagens, gera PDF sibling em paralelo (`buildPdfKeyFromImageKey` em L1369-1376) — mesmo path com `.pdf` no lugar da ext original.
8. **Suggest folder**: `rulesEngine.suggest()` (L201) — popula `suggestedFolder` + `finalFolder` (engine escreve path estilo `/Fornecedores/<slug>/2026-09/` em `finalFolder` para navegação lógica, **mas não move o arquivo** — só roteia a *string* que vai para o Folder tree).
9. Insere `Document` com `fileKey` + `fileHash` + `pdfKey`.
10. Audit log + auto-trigger extraction (fire-and-forget, com `.then/.catch` desde hardening 2026-09-01).

### 1.3 Storage abstraction existente

**Sim, já existe uma abstraction** — só não segue o shape do `oc-storage-patterns`. Está em `apps/api/src/modules/documents/storage/`:

| Arquivo | Conteúdo |
|---------|----------|
| `storage-service.interface.ts` | `StorageService` symbol + interface (put/getBuffer/remove/exists/getSignedUrl + `driver: 'local' \| 's3' \| 'minio'`) |
| `local-filesystem.storage.ts` | `LocalFilesystemStorage` com `resolveSafe()` (path traversal guard), atomic-write via temp+rename, mkdir recursive |
| `storage.module.ts` | `@Module` com `LocalFilesystemStorage` + provider token `@Inject(StorageService)` |

**Mapeamento pra abstraction do skill:**
- ✅ Interface `StorageService` já existe — **mas** não é exatamente igual ao `StorageAdapter` do skill (faltam `signedUrl` no contrato certo, etc — verificar antes de duplicar).
- ✅ `LocalFilesystemStorage` já implementa filesystem local — **mas** o `key` segue shape `<tenantId>/<yyyy>/<mm>/<random>`, NÃO `<storage>/fornecedores/<slug>/<YYYY-MM>/<doc>`. Para Sprint E há duas opções:
  - **(A)** Reusar a interface existente, só adaptar o `key` shape pra incluir `fornecedores/<slug>/<YYYY-MM>/` em vez de `<tenantId>/<yyyy>/<mm>/`.
  - **(B)** Criar nova interface `StorageAdapter` (do skill) ao lado — adiciona entropia, mas segue literalmente o brief.
- ⚠️ O env var é `UPLOADS_DIR` (não `STORAGE_PATH` como o brief sugere) — manter nome existente ou criar novo é decisão do builder (ver §11).
- ⚠️ O driver field é `'local' \| 's3' \| 'minio'` — já existe um S3 driver não-trivial planejado (S3_ENDPOINT/S3_ACCESS_KEY no .env).

**Recomendações do scout**: preferência forte pela **(A)** — reusar interface existente. NÃO criar `apps/api/src/common/storage/` novo (o brief pede isso, mas a abstração já vive em `apps/api/src/modules/documents/storage/`). Documentar isso no relatório do builder é obrigação.

### 1.4 Helper `slugify` já existe?

**Sim, já existe**, mas só **privado em `DocumentsService.slugifySegment()`** (L1304-1320) e não exportado. Faz NFD + strip combining marks + collapse `[A-Za-z0-9]` + trim hifens. **NÃO** tem cap de 60 chars que o skill propõe — o scout sugere reusar este método para `Party.slug` em vez de criar um duplicado em `apps/api/src/common/storage/slug.ts`.

### 1.5 Modelo Party atual (Prisma) — `apps/api/prisma/schema.prisma:545-605`

**Importante pro Sprint E:**
- `Party.slug` **NÃO EXISTE**. O campo equivalente é `name` (string livre, "EDP Comercial — Comercialização de Energia, SA"). Toda a navegação de pastas de hoje conta com `rulesEngine.suggest()` que faz slugify on-the-fly a partir do nome. Pra Sprint E, **precisamos decidir se introduzimos `Party.slug` (campo separado, único por tenant)** ou **derivamos on-the-fly** igual o folder-rules engine (ver §11 decisão 2).
- `Party.isRecurring: Boolean @default(false)` — flipado pelo `SupplierResolver.refreshRecurringFlag()` (>=3 docs).
- `Party.isRecurringManualOverride: Boolean @default(false)` — ADMIN-only, pausa auto-flip.
- `Party.contactRoles: String[]` — projection legacy de `type` (não usar).
- `Party.tenantId` — multi-tenant, então qualquer `PartyCategory` precisa de `tenantId` também (per-tenant).
- Relations: `documents Document[]` (back-relation), `payableItems PayableItem[]`, `ibanChanges IbanHistory[]`.

**Outros campos relevantes pra folder routing:**
- `type: PartyType @default(FORNECEDOR)` — FORNECEDOR | CLIENTE | AMBOS. Sprint E quer separar AMBOS em fornecedores/ e clientes/ baseado em rulesEngine existente que provavelmente já lida com isso (cheirar antes de implementar).
- `country: String @default("PT")` — usado por `rulesEngine` para decidir branch estrangeira (`Faturas/Estrangeiras/`).
- `defaultDebitAccountId`, `defaultCreditAccountId` — FK, mas **SEM relation line no Prisma** (linha 568-569 do schema — comentário L110 explica). Tem que hidratar via `accountById` Map no service (já feito em `PartiesService.findAll` L114-119).

### 1.6 Modelo Document — campos relevantes

Do schema L358-466:
- `fileKey: String` — path storage atual (privado, stripado em `sanitize()`). **Não exposto no response.**
- `fileHash: String` — SHA-256, dedup gate (`@@unique([tenantId, fileHash])`).
- `pdfKey: String?` — sibling PDF pra images. Sprint E precisa mover AMBOS em approve.
- `partyId: String?` — link opcional à `Party`. Sprint E precisa popular mais cedo (no upload idealmente, na extract realisticamente).
- `approvedAt`, `approvedById`, `status: APROVADO` — gates do auto-routing.
- `metadata.filing.expenseCategory` — já existe como sub-documento do metadata (não coluna), populado por extraction ou override manual (`writeFilingMetadata()` em `documents.service.ts:1415-1443`). Já tipado como `ExpenseCategory` enum (PT, 9 valores).

### 1.7 Hook do approve()

`DocumentsService.approve()` em L858-909 — chama `prisma.document.update` com status APROVADO + `approvedAt` + `approvedById` + audit log + cria `PaymentEvent` se faltar. **NÃO faz nada com storage** hoje. **Ponto de injeção do Sprint E**: depois do update, **antes do return** (ou após audit, em paralelo), chamar `relocateAfterApprove(tenantId, id)` que:
1. Lê `document.fileKey`, `pdfKey`, `party` (com `category`).
2. Calcula novo path via `buildDocumentPath()` do skill.
3. Move arquivo (não copia — ver §10 risks).
4. Atualiza `fileKey` (e `pdfKey`) no DB.
5. Log de audit.

### 1.8 Categorias hoje (`Category` model em schema L871-888)

É a tabela **`Category`**, NÃO `ExpenseCategory`. Campos:
- `id, tenantId, name, slug, color, defaultIvaDeductibilityPct (Int @default 100), notes, createdAt, updatedAt`
- `@@unique([tenantId, slug])`
- Relations: `documents Document[] @relation("DocumentCategory")` (back)

Serviço: `apps/api/src/modules/documents/categories.service.ts` (60 linhas) — CRUD + `ensureSeedForTenant()` que popula 9 categorias PT seed no primeiro acesso do tenant:
- Refeições, Combustível, Alojamento, Deslocações, Material de escritório, Serviços/FSE, Comunicações, Rendas, Outras.

**Sprint E cria `PartyCategory` (NÃO reusa `Category`)** — semântica diferente, conforme brief. Mas **espelha a estrutura**: `id, tenantId, slug, name, color, sortOrder, createdAt` + `parties.partyCategoryId` nullable. Provavelmente `@@unique([tenantId, slug])`. Ver §11 decisão 1 pra confirmar per-tenant.

### 1.9 Frontend party-form + types

- `apps/web/app/(dashboard)/parties/_components/party-form.tsx` (não está em `[id]/_components/` como o brief dizia — está em `_components/` raiz). Form completo já com `tipo, nome, nif, email, telefone, iban, bic, morada, cp, cidade, país, conta débito/crédito default, flags ADMIN`.
- `apps/web/app/(dashboard)/parties/_lib/types.ts` — `Party` interface (40 campos expostos) + `PartyInput`. Sem `partyCategoryId`. **Adicionar `partyCategoryId?: string | null` + `PartyCategory` interface.**
- `apps/web/app/(dashboard)/parties/page.tsx` — list com 3 tabs (entidades, contas, blacklist). **Não há filtro por categoria hoje.**

### 1.10 Migration lock + estado

- `apps/api/prisma/migration_lock.toml` tem `provider = "postgresql"`.
- Última migration: `20260903000000_add_recurring_override/`.
- Drift status: **verificar `prisma migrate status` antes de commit** — Sprint E adiciona `PartyCategory` + `parties.partyCategoryId`.

---

## 2. Decisões pré-confirmadas (NÃO mude, são ordens)

1. ✅ FILESYSTEM LOCAL — `LocalFilesystemStorage` no `apps/api/src/modules/documents/storage/` já é local.
2. ✅ **NÃO** criar `apps/api/src/common/storage/` novo — reusar `apps/api/src/modules/documents/storage/`. Se o builder quiser mover pra `common/`, documentar e justificar, mas o scout recomenda manter onde está (interface já é usada em 5+ call sites, mover quebra wiring).
3. ✅ Cria `PartyCategory` (não reusa `Category`) — semântica diferente (categoria de QUEM vs categoria de QUÊ).
4. ✅ Folder routing segue shape do `oc-storage-patterns`: `fornecedores/<slug>/<YYYY-MM>/<doc>`, `clientes/<slug>/<YYYY-MM>/<doc>`, `despesas/<YYYY-MM>/<doc>`, `_inbox/<YYYY-MM-DD>/<originalFilename>`.
5. ✅ Auto-routing dispara no **APPROVE**, não no upload.

---

## 3. Backend touchpoints (file:line)

| # | Arquivo | Linha(s) | Mudança proposta |
|---|---------|----------|------------------|
| 1 | `apps/api/prisma/schema.prisma` | L545-605 (Party) + novo bloco L605a (PartyCategory) | Adicionar model `PartyCategory` + relation `Party.partyCategoryId String?` apontando pra `PartyCategory.id` (nullable, onDelete: SetNull) |
| 2 | `apps/api/prisma/migrations/<ts>_add_party_categories/migration.sql` | novo | `CREATE TABLE party_categories` + `ALTER TABLE parties ADD COLUMN partyCategoryId` + FK + index. Espelhar a migration de `categories` mais recente |
| 3 | `apps/api/src/modules/parties/party-categories.controller.ts` | novo | `GET /party-categories` + `POST` + `PATCH/:id` + `DELETE/:id` (mesmo shape da `documents/categories.controller.ts`) |
| 4 | `apps/api/src/modules/parties/party-categories.service.ts` | novo | CRUD + `ensureSeedForTenant()` com defaults (ex: "Fornecedor", "Cliente", "Fornecedor estratégico", "Consultor") |
| 5 | `apps/api/src/modules/parties/dto/party-category.dto.ts` | novo | `CreatePartyCategoryDto`, `UpdatePartyCategoryDto`, `PartyCategoryQueryDto` |
| 6 | `apps/api/src/modules/parties/parties.service.ts` | update L244-430 (update) + sanitizeParty L1031-1046 | `update()` aceita `dto.partyCategoryId`; `assertCategoryExists()` helper; `sanitizeParty()` inclui `partyCategory` |
| 7 | `apps/api/src/modules/parties/dto/party.dto.ts` | UpdatePartyDto L160-180 | Adicionar `@IsOptional() @IsString() partyCategoryId?: string;` |
| 8 | `apps/api/src/modules/parties/parties.module.ts` | L20-28 | Adicionar `PartyCategoriesController`, `PartyCategoriesService`, `Category` import (reusar `Category` se for o caso, criar se novo). Exportar `PartyCategoriesService` |
| 9 | `apps/api/src/modules/documents/documents.service.ts` | upload L103-170 | Substituir `buildStorageKey()` por `buildStoragePath({ tenantId, party: party?, category: category?, documentDate: now, fileId: uuid, extension: ext })` (chamar helper) |
| 10 | `apps/api/src/modules/documents/documents.service.ts` | approve L858-909 | Adicionar `await this.relocateAfterApprove(tenantId, id)` após o update. Implementar helper privado: lê party (com category), computa novo path, move bytes, atualiza fileKey+pdfKey, audit log |
| 11 | `apps/api/src/modules/documents/storage/local-filesystem.storage.ts` | L33-37 + novo método `move()` | Adicionar `async move(oldKey: string, newKey: string): Promise<void>` — copy+delete+verify ou rename (ver §10 risks). Aceitar cross-folder |
| 12 | `apps/api/src/common/storage/path-builder.ts` | **NÃO CRIAR** se scouting aceita §2.2 — usar helper privado em documents.service | (alternativa: extrair `buildDocumentPath()` como pure-function em `apps/api/src/modules/documents/storage/path-builder.ts` para reuso + testes) |

> Nota do scout: a tabela tem 12 linhas mas só 11-12 arquivos únicos (3 vs 4-5 são todos em `parties/`). Contagem de arquivos de output do builder (excluindo migration) = ~10-11. Migration é +1.

---

## 4. Frontend touchpoints

| # | Arquivo | Mudança |
|---|---------|---------|
| 1 | `apps/web/app/(dashboard)/parties/_components/party-form.tsx` (L165-180 — Field defaultDebit account) | Adicionar nova `<Field label="Categoria">` com `<select>` carregado via `usePartyCategories()` (similar a `useSeedAccounts`). Em `onSubmit`, incluir `partyCategoryId: form.partyCategoryId \|\| undefined`. |
| 2 | `apps/web/app/(dashboard)/parties/_lib/types.ts` | Adicionar `PartyCategory` interface + `Party.partyCategoryId?: string \| null` + `Party.partyCategory?: PartyCategory \| null` + `PartyInput.partyCategoryId?: string` |
| 3 | `apps/web/app/(dashboard)/parties/_components/use-parties.ts` (não lido — deduzido) | Adicionar `usePartyCategories()` hook (GET /party-categories com SWR ou fetch+useState) |
| 4 | `apps/web/app/(dashboard)/parties/page.tsx` (opcional) | Adicionar filtro por categoria no PartiesList — dropdown "Categoria" + filter state |
| 5 | `apps/web/app/(dashboard)/parties/_components/parties-list.tsx` (opcional) | List view filtra por `partyCategoryId` quando query param está setado |

> Aviso: os arquivos `party-form.tsx`, `types.ts`, `use-parties.ts`, `parties-list.tsx` foram encontrados em `apps/web/app/(dashboard)/parties/_components/` e `apps/web/app/(dashboard)/parties/_lib/`, **NÃO** em `parties/[id]/_components/` como o brief dizia. O scout leu `party-form.tsx` + `types.ts` + `page.tsx` e confirmou estrutura. Confirmar `parties-list.tsx` + `use-parties.ts` antes de editar.

---

## 5. Migration Prisma — `add_party_categories`

```sql
-- migration.sql (esboço)

CREATE TABLE "party_categories" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "color"     TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "party_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "party_categories_tenantId_slug_key" ON "party_categories"("tenantId", "slug");
CREATE INDEX "party_categories_tenantId_idx" ON "party_categories"("tenantId");

-- FK
ALTER TABLE "party_categories" ADD CONSTRAINT "party_categories_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Parties.partyCategoryId nullable
ALTER TABLE "parties" ADD COLUMN "partyCategoryId" TEXT;
ALTER TABLE "parties" ADD CONSTRAINT "parties_partyCategoryId_fkey"
  FOREIGN KEY ("partyCategoryId") REFERENCES "party_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: seed básico por-tenant no `prisma migrate deploy`. Prisma não executa
-- backfill automático, então OU:
--   (a) Seed no application start (ensureSeedForTenant() chamado pelo parties
--       module onModuleInit ou first request)
--   (b) Documentar que operator roda `npx tsx scripts/seed-party-categories.ts`
-- Recomendação scout: (a). Mesmo padrão do `CategoriesService.ensureSeedForTenant`.
```

Defaults seed sugeridos (4 buckets):
1. **Operacional** (Fornecedor genérico, cor neutra) — cor `#64748B`
2. **Estratégico** (Fornecedor chave, recorrente) — cor `#3B82F6`
3. **Consultor / Serviços** — cor `#8B5CF6`
4. **Cliente** (Cliente recorrente) — cor `#10B981`

(Aplicar mesma lógica do `documents/categories.service.ts:5-15`.)

---

## 6. Storage abstraction

**Já existe** em `apps/api/src/modules/documents/storage/`. NÃO criar duplicado.

**Gap a fechar:**
- ✅ Interface — `StorageService` symbol-based.
- ✅ Local driver — `LocalFilesystemStorage` com `put/getBuffer/remove/exists/getSignedUrl`.
- ❌ **`move()`** — não existe. Sprint E precisa adicionar:
  ```typescript
  async move(oldKey: string, newKey: string): Promise<void> {
    const from = this.resolveSafe(oldKey);
    const to = this.resolveSafe(newKey);
    // garantir pasta destino existe
    await fs.mkdir(path.dirname(to), { recursive: true });
    // tentar rename atomic (Linux/macOS sim, Windows ❌ em cross-volume)
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      // fallback cross-platform: copy + verify + unlink
      await fs.copyFile(from, to);
      const srcStat = await fs.stat(from);
      const dstStat = await fs.stat(to);
      if (srcStat.size !== dstStat.size) {
        await fs.unlink(to).catch(() => undefined);
        throw new Error(`move verification failed: ${oldKey} → ${newKey}`);
      }
      await fs.unlink(from);
    }
  }
  ```

- ❌ **Helper `buildDocumentPath()` determinístico** — implementar:
  - Local: `apps/api/src/modules/documents/storage/path-builder.ts` (novo arquivo, export puro sem DI).
  - Cobre: `partyType: 'FORNECEDOR'|'CLIENTE'|null`, `partySlug: string|null`, `partyCategorySlug: string|null`, `documentDate: Date`, `documentNumber: string`, `fileId: string`, `extension: string`.
  - Mesma lógica do skill (L24-43 do skill).

---

## 7. Auto-routing no approve

Em `DocumentsService.approve()` (L858-909), depois do `await this.prisma.document.update({ status: APROVADO ... })` (L885) e antes do `return this.sanitize(updated)` (L908):

```typescript
// Novo no approve()
await this.relocateAfterApprove(tenantId, id, userId);
```

E um novo método privado:
```typescript
private async relocateAfterApprove(
  tenantId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const doc = await this.prisma.document.findFirst({
    where: { id: documentId, tenantId },
    include: {
      party: {
        select: {
          id: true, type: true, name: true,
          partyCategory: { select: { slug: true } },
        },
      },
    },
  });
  if (!doc) return; // approve já fez o throw, não duplicar
  if (!doc.party) return; // sem party → deixa em inbox (precisa classificação manual)
  if (!doc.fileKey?.includes('/_inbox/')) return; // não está em inbox → já foi movido

  const newPath = buildDocumentPath({
    partyType: doc.party.type === 'CLIENTE' ? 'CLIENTE' : 'FORNECEDOR',
    partySlug: slugify(doc.party.name),
    partyCategorySlug: doc.party.partyCategory?.slug ?? null,
    documentDate: doc.docDate ?? new Date(),
    documentNumber: doc.docNumber ?? 'unnumbered',
    fileId: doc.id, // reusa o CUID do Document como stable ID
    extension: extractExtensionFromKey(doc.fileKey) ?? 'pdf',
  });
  // move byte-by-byte (ver §10 risks)
  await this.storage.move(doc.fileKey, newPath);
  if (doc.pdfKey) {
    const newPdfKey = newPath.replace(/\.[^.]+$/, '.pdf');
    await this.storage.move(doc.pdfKey, newPdfKey);
  }
  // atualiza DB
  await this.prisma.document.update({
    where: { id: documentId },
    data: { fileKey: newPath, pdfKey: doc.pdfKey ? ... : null },
  });
  // audit log
  await this.audit.log({
    tenantId, userId,
    action: AuditAction.EDIT,
    entityType: 'document',
    entityId: documentId,
    metadata: { subAction: 'storage.relocate', from: doc.fileKey, to: newPath },
  });
}
```

> Esta lógica deve ser **idempotente** — se já não está em `_inbox/`, não move. Se aprovado 2x, não tenta mover de novo.

---

## 8. Testes novos (escopo a incluir)

| Arquivo | Cobertura |
|---------|-----------|
| `apps/api/src/modules/documents/__tests__/path-builder.spec.ts` | edge cases: nome com acentos (Américo Alves), espaços, unicode, party null, partyCategory null, documentDate no mês passado, extensão vazia, `docNumber` com `/` |
| `apps/api/src/modules/documents/__tests__/local-filesystem.move.spec.ts` | move cross-folder, move cross-volume (mock), idempotência, arquivo sumido |
| `apps/api/src/modules/parties/__tests__/party-categories-crud.spec.ts` | CRUD completo, `ensureSeedForTenant`, slug duplicado no mesmo tenant, slug duplicado cross-tenant (deve passar), reflow ao deletar category com parties linkadas |
| `apps/api/src/modules/documents/__tests__/approve-folder-routing.spec.ts` | happy path (party+category → move), no-party (skip), already-not-in-inbox (skip), pdf key movement, audit log, idempotência |
| `apps/api/src/modules/parties/__tests__/party-category-id-update.spec.ts` | UPDATE party com categoryId, sem categoryId (null = clear), categoryId inválido (404) |

> Já existe `apps/api/src/modules/parties/parties.service.spec.ts` (39186 bytes) — adicionar ao lado, não dentro.

---

## 9. Estimativa de diff

- **Backend**: 9-10 arquivos (1 schema, 1 migration, 1 party-category.controller, 1 service, 1 dto, 1 storage path-builder, 1 storage move fn, 1 documents.service change, 1 module wire, 1 dto change)
- **Frontend**: 3-4 arquivos (party-form.tsx + types.ts + use-parties.ts + opcional list filter)
- **Testes**: 4-5 arquivos novos
- **Total**: 16-19 arquivos (slightly acima do "12-16" do brief — justificado pelo move() method novo)
- **Linhas**: ~350-500 (acima do "~250-400" — mesmo motivo)

---

## 10. Risks/Gotchas

| Risco | Severidade | Mitigação |
|-------|-----------|-----------|
| **rename atômico cross-platform**: Linux OK, Windows cross-volume falha | ALTA | `move()` faz copy+verify+unlink; ver §6 |
| **Race condition 2 approves simultâneos** | MÉDIA | `approve()` já tem state machine (segundo approve = idempotente). Mas o `relocateAfterApprove` precisa de lock — opções: (a) row-level Prisma advisory lock via `$transaction`, (b) DB-level `SELECT FOR UPDATE` via raw query, (c) Redis SETNX. Recomendo (a) — barato, suficiente |
| **Slug duplicado pós-rename** | MÉDIA | `slugify(doc.party.name)` com mesmo input = mesmo output (NFD + ASCII + collapse). Mas se duas parties têm o mesmo slug ("EDP Comercial" e "EDP, Comercial"), colidem no filesystem. Builder adiciona suffix de party.id (`<slug>-<party.id.slice(0,4)>`) ou hash curto |
| **Slug com acentos PT**: `Américo Alves` → slugify → `americo-alves` ✅. Mas se migration usa NFD antiga (sem strip), pode ficar `americo-alves` com encoding UTF-8 BOM inesperado em Windows | BAIXA | reusar `DocumentsService.slugifySegment()` (já testado em Sprint D) em vez de criar novo |
| **pdfKey sibling quebrado** | MÉDIA | `move()` chamado para AMBOS `fileKey` + `pdfKey`. Se um falha, deixar o outro parcialmente movido é falha. Builder deve usar `transaction`: se `pdfKey.move()` falhar, reverter `fileKey.move()` (restore via rename) ou usar copy-then-delete atômico |
| **`extraction.service` rodando async pode ter deletado arquivo?** | BAIXA | `extraction.service` hoje **não deleta arquivo** — só enriquece metadata. Confirmar antes, mas o scout verificou `documents.service.ts` e não há delete após upload |
| **Tenant novo sem Folder tree ainda** | BAIXA | `materialiseFolderPath()` no approve cria a Folder row on-demand. Auto-routing em storage key NÃO depende disso — são sistemas paralelos. Confirmar separação conceitual |
| **Apple macOS dev path vs Linux prod path**: filesystem separator vs `path.posix` | BAIXA | `LocalFilesystemStorage.resolveSafe()` já usa `path.posix.normalize()` — consistente |
| **`Document.fileKey` exfiltration via API**: já stripado em `sanitize()` L1101-1110 | BAIXA | Mantido. Storage key interno não vaza |
| **Migration rollback** | BAIXA | `ALTER TABLE ... DROP COLUMN partyCategoryId` reverte. Set FK ON DELETE SET NULL garante integridade |
| **`Party.slug` field vs derived**: ainda não decidido | — | Ver §11 |

---

## 11. Decisões que o builder vai precisar tomar

### Decisão 1: `PartyCategory` é global (per-tenant) ou per-row?
**Recomendado: per-tenant** (campo `tenantId` em `PartyCategory`, mesmo padrão de `Category`).
- Motivo: DocFlow é multi-tenant desde schema `Tenant` L185-241. Compartilhar categorias entre tenants viola isolamento de dados.
- Consequência: seed precisa rodar no `ensureSeedForTenant()` (mesmo padrão de `CategoriesService.ensureSeedForTenant()` L21-27).

### Decisão 2: `Party.slug` derivado on-the-fly vs campo persistido?
**Recomendado: híbrido** — campo `Party.slug String?` persistido (gerado na criação via `slugify(name)`, com collision check + suffix `<slug>-<id>.slice(0,4)`), mas **re-derivado** em qualquer PATCH de `name` se necessário.
- **Razão**: a) navegação de storage precisa de slug estável (rename de party NUNCA renomeia arquivo); b) `Party.slug` permite URL canônica `/parties/<slug>` no futuro; c) Collision check (unique constraint com suffix garante zero collisions).
- **Custo**: +1 coluna + +1 migration, +1 helper `slugifyParty(name)` em `PartiesService`. Pequeno.

### Decisão 3: Storage root path — env var `UPLOADS_DIR` (existente) vs `STORAGE_PATH` (do brief)?
**Recomendado: manter `UPLOADS_DIR`** (não quebra callers atuais) + adicionar `STORAGE_FORNECEDORES_PATH` opcional para split entre paths de inbox e categorizados se necessário.
- **Razão**: `LocalFilesystemStorage` já lê `UPLOADS_DIR` (L34 de local-filesystem.storage.ts). Mudar nome = refactor em 5+ call sites. Não vale o candle.
- **Exceção**: se operação/marketing separar `storage/` raiz do `uploads/` (limpeza semântica), documentar no RFC e fazer separadamente.

### Decisão 4: Filesystem permissions — Node user write?
**Recomendado: validar no boot do `LocalFilesystemStorage.onModuleInit()`** (L39-42), com `fs.access(this.rootDir, fs.constants.W_OK)` check + warn loud no log se falhar.
- Já chama `mkdir({ recursive: true })` mas não verifica write. Sprint E pode adicionar essa checagem como fail-fast se env for produção.

### Decisão 5: `PartyType.AMBOS` — vai pra `fornecedores/` OU `clientes/`?
**Recomendado: AMBOS → fallback `despesas/`**, a menos que decisão explícita seja tomada. AMBOS é uma má-prática de modelagem (uma party não é das duas coisas ao mesmo tempo na vida real de accounting PT), mas se já existe na DB, default pra `despesas/` evita path-travessia ambígua.
- Alternativa: criar dois folders (symlink ou mirror) — fora do escopo Sprint E.

### Decisão 6: Idempotência do relocate — o que define "precisa mover de novo"?
**Recomendado: `fileKey.startsWith('_inbox/')`** (string match exato, prefixo já é literal sem chars especiais).
- Mais robusto: usar `metadata.filing.location: 'inbox' | 'final'` flag. Mas adiciona complexidade e schema change. Recomendo string match + signoff explícito.

### Decisão 7: Namespacing do helper `path-builder` — common/ vs storage/ vs documents/
**Recomendado**: criar `apps/api/src/modules/documents/storage/path-builder.ts` (não `common/`) — porque já há storage interface nesse dir, e path-builder é parte do contrato de storage.
- Test fica em `__tests__/path-builder.spec.ts` ao lado do source.

---

## 12. Pre-flight checks pro builder

Antes de commitar:

- [ ] `pnpm --filter api prisma migrate status` — confirmar zero drift
- [ ] `pnpm --filter api prisma migrate dev --name add_party_categories` — gera SQL + cliente
- [ ] Revisar `migration.sql` gerado contra §5 deste doc
- [ ] `pnpm --filter api test path-builder.spec.ts` — testes do helper passam
- [ ] `pnpm --filter api test approve-folder-routing.spec.ts` — approve moves file
- [ ] `pnpm --filter api test party-categories-crud.spec.ts` — CRUD básico
- [ ] Smoke test: upload 1 PDF → approve com party linkada → confirmar arquivo em `apps/api/uploads/_inbox/` foi pra `apps/api/uploads/fornecedores/<slug>/<YYYY-MM>/`
- [ ] Smoke test: PATCH party com `partyCategoryId` → reload detail → ver categoria
- [ ] UI: `/parties/new` ou `/parties/<id>` mostra select "Categoria" + lista 4 defaults

---

## 13. Resumo executivo pro caller

**Pronto pra construir.** Terreno mapeado — todas as integrações conhecidas, abstração de storage já existe (apenas adicionar `move()`), modelo `Party` aceita `partyCategoryId` nullable sem FK surprise, hook do `approve()` tem slot claro pra `relocateAfterApprove()`, frontend tem 1 form + 1 types file + 1 hook pra tocar, testes têm precedente em `parties.service.spec.ts` (39 KB já escrito).

**Decisões acima são 7 — todas pequenas**. As duas mais impactantes são:
- **Decisão 2**: introduzir `Party.slug` persistido (afeta model + migration + service.update sanitize).
- **Decisão 3**: manter `UPLOADS_DIR` env var existente (afeta zero code, mas documentação RFC-friendliness vs brief).

**Riscos bloqueantes**: zero identificados. `extraction.service` não deleta arquivo. Rename cross-volume tem fallback (copy+verify+unlink) já descrito. Race tem lock trivial (Prisma `$transaction`).

**Estimativa final do scout**: ~350-500 linhas, 11 arquivos backend + 4 frontend + 5 testes + 1 migration = **~21 arquivos** (acima do brief 12-16). Justificativa: incluir testes + `move()` method novo inflates contagem mas é trabalho necessário, não scope creep.

**Arquivos lidos** (evidência):

1. `apps/api/prisma/schema.prisma` (schema completo, 1271 linhas)
2. `apps/api/src/modules/documents/documents.service.ts` (1636 linhas — foco no upload + approve + storageKey helpers)
3. `apps/api/src/modules/parties/parties.controller.ts` (400 linhas)
4. `apps/api/src/modules/parties/parties.service.ts` (1054 linhas)
5. `apps/api/src/modules/parties/dto/party.dto.ts` (244 linhas)
6. `apps/api/src/modules/parties/parties.module.ts` (28 linhas)
7. `apps/api/src/modules/documents/storage/local-filesystem.storage.ts` (127 linhas)
8. `apps/api/src/modules/documents/storage/storage-service.interface.ts` (68 linhas)
9. `apps/api/src/modules/documents/storage/storage.module.ts` (22 linhas)
10. `apps/api/src/modules/documents/documents.module.ts` (33 linhas)
11. `apps/api/src/modules/documents/categories.service.ts` (60 linhas — referência)
12. `apps/api/src/modules/documents/categories.dto.ts` (36 linhas — referência)
13. `apps/api/.env` (configuração)
14. `apps/web/app/(dashboard)/parties/_components/party-form.tsx` (form completo)
15. `apps/web/app/(dashboard)/parties/_lib/types.ts` (types Party)
16. `apps/web/app/(dashboard)/parties/page.tsx` (listagem 3 tabs)
17. `audit-and-ui-overhaul/DESIGN-SYSTEM.md` (primeiras 100 linhas — paleta)
18. Listagem `apps/api/uploads/<tenant>/<yyyy>/<mm>/` — confirmado layout atual
19. Skill `oc-storage-patterns` carregada ✅

**Inferido mas não lido (builder deve confirmar antes de editar)**:
- `apps/web/app/(dashboard)/parties/_components/use-parties.ts` (hook listagem — provavelmente onde mora `usePartyCategories` se quiser centralizar)
- `apps/web/app/(dashboard)/parties/_components/parties-list.tsx` (UI do filtro)
- `apps/api/prisma/migrations/<latest>/migration.sql` (checar formato exato + naming conventions para Sprint E migration)
- `apps/api/src/modules/extraction/extraction.service.ts` (confirmar que não deleta arquivo após upload — apenas enriquece metadata)

---

*Fim do SCOUT_REPORT. Status: ready for builder.*
