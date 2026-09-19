# Sprint G — Party 360° file — SCOUT REPORT

**Branch:** main · **HEAD:** a0fd9b6 · **Working dir:** C:\Projetos\docflow-mvp
**Status:** READ-ONLY — no edits performed

---

## 1. Estado atual

### 1.1 Como `Party` é modelada hoje (flatten)
**File:** `apps/api/prisma/schema.prisma` L549–626

O model `Party` é uma **single-table flatten** com colunas escalares para cada contacto/morada, e.g. `email`, `phone`, `mobile`, `address`, `city`, `postalCode`, `country` — não há qualquer relação 1-N para múltiplos contactos ou múltiplas moradas.

Campos "fixos" (limitados a 1 por Party):
- `email` — string única, sem normalização
- `phone`, `mobile` — duas strings separadas, sem coleção
- `address`, `city`, `postalCode`, `country` — uma só morada (um só país "PT" por default)
- `iban`, `bic` — únicos flatten
- Legacy/projection no schema: `contactRoles String[] @default([])` no body (L611), descrito como "legacy/projection of type" — não é usado pela lógica actual, é um vestígio

Relations existentes em `Party`:
- `documents Document[]` (L608) via `Document.partyId`
- `payableItems PayableItem[]` (L609) via `PayableItem.partyId`
- `ibanChanges IbanHistory[]` (L610) via `IbanHistory.partyId`
- `partyCategory PartyCategory?` (L602) — Sprint E bucket
- Tenant (L551)
- Accounts FK escalares `defaultDebitAccountId`/`defaultCreditAccountId` — **sem relation Prisma** (L572–574); o service hidrata via `findMany` extra (parties.service.ts L116–128, L147–156)

### 1.2 Histórico / audit já existentes
- **AuditAction enum** (schema L125–143): `LOGIN, LOGOUT, UPLOAD, CREATE, EDIT, DELETE, APPROVE, REJECT, IMPORT, EXPORT, RECONCILE, PAYMENT_INIT, PAYMENT_CONFIRM, CREATE_TENANT, INVITE_USER, ROLE_CHANGE, INTEGRATION_SYNC`
- **AuditLog** (schema L325–…): append-only, hash-chained (`prevHash`/`rowHash`), `entityType`+`entityId` permitem filtro por tipo ("party")
- **IbanHistory** (schema L657–673): `oldIban`, `newIban`, `changedById`, `reason`, `verified`, `createdAt` — cada IBAN change escreve uma row em transaction
- **PaymentEvent** (schema L939–959): FK para `Document` (NÃO para `Party`!), `dueDate`, `amount`, `status`, `paidAt`, `paidAmount`. ⚠ **Não há `partyId` em PaymentEvent** — o caminho para Timeline events de pagamento **via `document.partyId`** (precisa JOIN)
- **Document** (schema L362–…): `partyId String?` (nullable, L416), `approvedAt DateTime?` (L440, 441–442 têm `approvedBy`), `status` enum incluindo `APROVADO`

### 1.3 UI atual — `/parties/[id]/page.tsx`
Layout em **2-col + section** (não tem tabs):
- `lg:col-span-2` → `PartyForm` (form flatten com email/phone/mobile/address/city/... + IBAN + partyCategory + contas default)
- `lg:col-span-1` → `PartyIbanPanel` (badge "Recorrente" + risk score + history list)
- `mt-5` → `PartyRecentDocuments` (só quando `party.type === 'FORNECEDOR'`)
- Header: `PageHeader` + `<Link href="/parties">Voltar</Link>` + badge de recorrência

Faltam: tabs, lista de contactos múltiplos, lista de moradas múltiplas, lista de PaymentEvents cronológica, lista de IbanHistory (existe dentro do panel — pode ser reusado), Timeline agregada.

Componentes auxiliares existentes:
- `apps/web/app/(dashboard)/parties/[id]/_components/party-recent-documents.tsx` — reusa `usePartyDocuments` (já existe, exibe 10 docs mais recentes do Party)
- `apps/web/app/(dashboard)/parties/_components/party-detail.tsx` — contém `PartyIbanPanel` (risk score + history list + botões verify/flag)
- `apps/web/app/(dashboard)/parties/_components/party-form.tsx` — form flatten com todos os campos email/phone/mobile/iban/address/etc.
- `apps/web/app/(dashboard)/parties/_components/parties-list.tsx` — **não vai mudar**
- `apps/web/app/(dashboard)/parties/_lib/types.ts` — types partilhados (Party, PartyInput, IbanHistoryEntry, IbanRiskReport, PartyDocument)
- `apps/web/app/(dashboard)/parties/_components/use-parties.ts` — React Query hooks

---

## 2. Decisões pré-confirmadas (NÃO MUDAR)

1. Sprint G adiciona **2 novas models**: `PartyContact` + `PartyAddress` (one-to-many via Prisma relation)
2. Opcional: `PartyNote` (Sprint G.2 se houver tempo)
3. UI: **6 abas** (Identity / Contacts / Documents / Payments / IBAN / Timeline) na página `/parties/[id]`
4. Timeline agrega de: `AuditLog (entityType='party' AND entityId=:id)`, `PaymentEvent (via Document.partyId=:id)`, `IbanHistory (partyId=:id)`, `Document (partyId=:id AND status='APROVADO')` — ordenado desc, scroll infinito

---

## 3. Backend touchpoints (file:line)

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `apps/api/prisma/schema.prisma` L549–627 + L657–673 + L939–959 | adicionar `model PartyContact` + `model PartyAddress` + `enum PartyAddressType` + relations em `Party` (incluindo `contacts PartyContact[]` + `addresses PartyAddress[]` cascade) |
| 2 | `apps/api/prisma/migrations/<ts>_add_party_contacts_addresses/migration.sql` (novo) | `CREATE TABLE party_contacts` + `party_addresses` + `ALTER TABLE parties ADD COLUMN ...` (se algum campo flatten ficar deprecado) + `CREATE INDEX ...` |
| 3 | `apps/api/src/modules/parties/party-contacts.controller.ts` (novo) | CRUD nested: `GET /parties/:partyId/contacts`, `POST`, `PATCH/:id`, `DELETE/:id`. `@Roles(Role.ADMIN)` (mesmo padrão de mutação do PATCH /parties/:id) |
| 4 | `apps/api/src/modules/parties/party-contacts.service.ts` (novo) | CRUD + `assertPartyInTenant(tenantId, partyId)` + `sanitizePartyContact` (nunca retornar `tenantId`, mesmo padrão de `sanitizeParty` em parties.service.ts L1116–1131) |
| 5 | `apps/api/src/modules/parties/dto/party-contact.dto.ts` (novo) | `CreatePartyContactDto` (`@IsString name, @IsOptional role/email/phone/notes, @Matches email`), `UpdatePartyContactDto` (PartialType), `PartyContactQueryDto` (limit/offset, capped 200) |
| 6 | `apps/api/src/modules/parties/party-addresses.controller.ts` (novo) | CRUD nested, mesma estrutura que contacts |
| 7 | `apps/api/src/modules/parties/party-addresses.service.ts` (novo) | CRUD + **`isPrimary` mutation logic** em transaction: (1) `UPDATE old party_addresses WHERE partyId+type isPrimary=true SET isPrimary=false`; (2) `INSERT NEW isPrimary=true`. Tudo dentro de `prisma.$transaction` + advisory lock keyed em `(partyId, type)` para evitar races entre POST/PATCH concorrentes |
| 8 | `apps/api/src/modules/parties/dto/party-address.dto.ts` (novo) | DTOs com `@IsEnum(PartyAddressType)`, `IsBoolean isPrimary`, `IsString line1/country`, `IsOptional line2/postalCode/city`, `Matches` quando aplicável |
| 9 | `apps/api/src/modules/parties/parties.module.ts` (modificar L1–29) | importar `PartyContactsModule` + `PartyAddressesModule` + `PartyTimelineModule` (forwardRef não necessário — Timeline só lê) |
| 10 | `apps/api/src/modules/parties/parties.service.ts` (modificar L1116–1131 `sanitizeParty`) | incluir `contacts: PartyContact[]` + `addresses: PartyAddress[]` (ordenados por `isPrimary DESC`); também ajustar `findOne` L136–158 `include` para hidrar as relações. **Não usar `findMany` separado** — usar Prisma `include` nativo (não há o problema de FK escalar visto com defaultDebitAccountId) |
| 11 | `apps/api/src/modules/parties/timeline/timeline.service.ts` (novo módulo `PartyTimelineModule`) | `timeline.service.ts` agrega eventos de 4 fontes; `timeline.controller.ts` com `GET /parties/:id/timeline?cursor=&limit=20` (scroll infinito) |
| 12 | `apps/api/src/modules/parties/timeline/dto/timeline.dto.ts` (novo) | `TimelineEventDto` union com `discriminator`: `'audit' \| 'payment' \| 'iban_change' \| 'document_approved'`. Cada variante carrega `{ id, type, at: ISO, ...rest }` |

### Notas técnicas específicas do Sprint G

**HOTFIX já presente (Sprint E H-05):** `parties.service.ts` L417–438 já colapsa a transaction party.update + ibanHistory.create corretamente — o novo módulo de Timeline pode confiar nesse invariante.

**Auth pattern atual:** os endpoints mutáveis usam `@Roles(Role.ADMIN)` (ver parties.controller.ts L200). Contacts/Addresses CRUD deve seguir o mesmo padrão: `@Roles(Role.ADMIN)` em POST/PATCH/DELETE; GET pode ser autenticado (sem role gate), porque toda a tabela é tenant-scoped via `req.user.tenantId`.

**Sanitize:** o `sanitizeParty` (parties.service.ts L1116–1131) é o modelo — strip `tenantId`, mantém o resto. O mesmo padrão para `sanitizePartyContact` / `sanitizePartyAddress`.

---

## 4. Frontend touchpoints

| # | Arquivo | Mudança |
|---|---|---|
| 1 | `apps/web/app/(dashboard)/parties/[id]/page.tsx` (refatorar L1–104) | trocar grid `lg:col-span-2`+`lg:col-span-1` por **`useState<PartyTab>('identity')`** + render condicional por aba. Header permanece. Deep-link via `useSearchParams().get('tab')` (`/parties/[id]?tab=payments`) |
| 2 | `apps/web/app/(dashboard)/parties/[id]/_components/party-tabs.tsx` (novo) | Tabs nav com contadores por aba (`Identity` · `Contacts` (count) · `Documents` (count) · `Payments` (count) · `IBAN` (count) · `Timeline`). Usar `lucide-react` (já em uso) com ícones `User/Users/FileText/CreditCard/Wallet/History` |
| 3 | `apps/web/app/(dashboard)/parties/[id]/_components/contacts-tab.tsx` (novo) | Lista de `PartyContact[]` + `AddContactDialog` (modal `useState`) + `EditContactDialog` + botão delete por row. Avatar circular com iniciais (computed via `name.split(' ').map(p=>p[0]).slice(0,2).join('')`). Badge email vazio |
| 4 | `apps/web/app/(dashboard)/parties/[id]/_components/addresses-tab.tsx` (novo) | Lista de `PartyAddress[]` agrupada por `type` (`BILLING/CORRESPONDENCE/OPERATIONAL/OTHER`) + badge `isPrimary` (verde, primeiro do grupo) + flag do país no label `country.toUpperCase()` |
| 5 | `apps/web/app/(dashboard)/parties/[id]/_components/documents-tab.tsx` (novo) | Reusar/compor `PartyRecentDocuments` (já existe, L1–139 de `[id]/_components/party-recent-documents.tsx`) — só envelopar para consumir como tab content. **Não criar nova API** — `GET /parties/:id/documents` já existe no controller L165–197 |
| 6 | `apps/web/app/(dashboard)/parties/[id]/_components/payments-tab.tsx` (novo) | Lista de `PaymentEvent[]` (via JOIN em `Document.partyId` — backend ou client filter). Status badges `pendente/pago/vencido` + total em EUR somado no header. **Decisão builder** (ver §8): API nova `GET /parties/:id/payments` ou reuso de `GET /documents?partyId` |
| 7 | `apps/web/app/(dashboard)/parties/[id]/_components/iban-tab.tsx` (novo) | Lista de `IbanHistory[]` (hook `useIbanHistory` já existe em use-parties L37) + risk-score donut (extrair do `PartyIbanPanel` L23–120 — donut pode ser SVG simples com stroke-dasharray) |
| 8 | `apps/web/app/(dashboard)/parties/[id]/_components/timeline-tab.tsx` (novo) | Vertical timeline com **infinite scroll** via `useInfiniteQuery` (React Query v5) — `IntersectionObserver` no sentinel `<div ref={sentinelRef}>`. Iconografia diferenciada por `type` (audit=lápis, payment=cifrão, iban=escudo, document=file-check) |
| 9 | `apps/web/app/(dashboard)/parties/_lib/types.ts` (modificar L1–189) | adicionar `PartyContact`, `PartyAddress`, `PartyAddressType` (`'BILLING' \| 'CORRESPONDENCE' \| 'OPERATIONAL' \| 'OTHER'`), `TimelineEvent` (union com discriminator), `TimelineListResponse` |
| 10 | `apps/web/app/(dashboard)/parties/_components/use-parties.ts` (modificar L1–...) | adicionar hooks: `usePartyContacts(partyId)`, `usePartyAddresses(partyId)`, `usePartyTimeline(partyId)` (com `useInfiniteQuery` + `getNextPageParam`). Mutações correspondentes: `useCreateContact`, `useUpdateContact`, `useDeleteContact`, `useCreateAddress`, `useUpdateAddress`, `useDeleteAddress`. Pattern: `partyKeys.contacts(partyId)` etc. adicionado a `partyKeys` L33–43 |

---

## 5. Detalhes técnicos Sprint G

### 5.1 Models Prisma (proposta)

```prisma
enum PartyAddressType {
  BILLING        // faturação
  CORRESPONDENCE // morada postal
  OPERATIONAL    // armazém / sede
  OTHER
}

model PartyContact {
  id        String   @id @default(cuid())
  tenantId  String
  partyId   String
  name      String
  role      String?  // CFO, contabilista, comercial, etc.
  email     String?
  phone     String?
  notes     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  party Party @relation(fields: [partyId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, partyId, email])  // trim vazio para null antes de insert
  @@index([partyId])
  @@index([tenantId, partyId])
  @@map("party_contacts")
}

model PartyAddress {
  id          String           @id @default(cuid())
  tenantId    String
  partyId     String
  type        PartyAddressType
  line1       String
  line2       String?
  postalCode  String?
  city        String?
  country     String           @default("PT")
  isPrimary   Boolean          @default(false)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  party Party @relation(fields: [partyId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([partyId])
  @@index([partyId, type, isPrimary]) // "qual o endereço primário do tipo X?"
  @@map("party_addresses")
}
```

**Adicionar em `Party`** (schema L608–611):
```prisma
  contacts  PartyContact[]
  addresses PartyAddress[]
```

**Constraint customizado:** para cada `partyId+type`, no máximo 1 com `isPrimary=true`. Postgres aceita partial unique (`@@unique([partyId, type]) WHERE isPrimary`), mas Prisma 4 não suporta essa cláusula na DSL — confirmar com `prisma migrate diff --preview-features` se a geração produz o `CREATE UNIQUE INDEX ... WHERE isPrimary`. **Fallback:** enforçar em service-level dentro de `prisma.$transaction` com `pg_advisory_xact_lock(hashtext('party_address_primary:' || partyId || ':' || type))`, padrão já documentado nas skills `oc-api-audit §12` e na fix-up H-05 do Sprint E (parties.service.ts L423).

### 5.2 Timeline aggregation

**Endpoint:** `GET /api/v1/parties/:id/timeline?cursor=&limit=20`
- `cursor` = ISO timestamp do último evento carregado (ou `{at,id}` se 2 eventos no mesmo ms — composite cursor — ver §7 risk)
- `limit` = 1..50 (default 20)

**4 fontes unificadas (queries independentes):**

```ts
const [audits, payments, ibans, approvedDocs] = await Promise.all([
  prisma.auditLog.findMany({
    where: { tenantId, entityType: 'party', entityId: id, ...(cursor && { createdAt: { lt: cursor } }) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  }),
  // PaymentEvent NÃO tem partyId — JOIN via Document
  prisma.paymentEvent.findMany({
    where: {
      tenantId,
      document: { partyId: id },
      ...(cursor && { createdAt: { lt: cursor } }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { document: { select: { id: true, fileName: true, docNumber: true } } },
  }),
  prisma.ibanHistory.findMany({
    where: { tenantId, partyId: id, ...(cursor && { createdAt: { lt: cursor } }) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  }),
  prisma.document.findMany({
    where: { tenantId, partyId: id, status: 'APROVADO', ...(cursor && { approvedAt: { lt: cursor } }) },
    orderBy: { approvedAt: 'desc' },
    take: limit,
    select: { id: true, fileName: true, docNumber: true, approvedAt: true, approvedById: true },
  }),
]);
```

**Normalizar e merge** com `timestamp` discriminado:
```ts
type Event = { id: string; type: 'audit'|'payment'|'iban_change'|'document_approved'; at: string; ...rest };
const events: Event[] = [
  ...audits.map(a => ({ id: a.id, type: 'audit', at: a.createdAt.toISOString(), action: a.action, metadata: a.metadata })),
  ...payments.map(p => ({ id: p.id, type: 'payment', at: p.createdAt.toISOString(), amount: p.amount, status: p.status })),
  ...ibans.map(i => ({ id: i.id, type: 'iban_change', at: i.createdAt.toISOString(), oldIban: i.oldIban, newIban: i.newIban, verified: i.verified })),
  ...approvedDocs.map(d => ({ id: d.id, type: 'document_approved', at: d.approvedAt!.toISOString(), fileName: d.fileName, docNumber: d.docNumber })),
];
events.sort((a, b) => b.at.localeCompare(a.at));  // desc
return { events: events.slice(0, limit), nextCursor: events.length > limit ? events[limit - 1].at : null };
```

**Performance note:** cada `take: limit=20`, e o slice final corta para `limit`. Acceptable para Sprint G; otimização futura (cursor único via Prisma union / raw SQL) fica como technical debt.

### 5.3 UX das abas (specs)

| Tab | Conteúdo | Estado vazio |
|---|---|---|
| **Identity** | `PartyForm` (form flatten existente) | — |
| **Contacts** | Lista `PartyContact[]` + add/edit/delete + avatar com iniciais + email/role display | "Sem contactos — adicione o primeiro" |
| **Documents** | `PartyRecentDocuments` (já existe, FORNECEDOR only) | "Sem faturas associadas" (text já no componente L88–92) |
| **Payments** | Lista `PaymentEvent[]` + sum EUR no header + status badges | "Sem eventos de pagamento" |
| **IBAN** | `IbanHistory[]` + risk-score donut | "Sem histórico IBAN" |
| **Timeline** | Vertical infinite scroll com ícones diferenciados por tipo | "Sem eventos — o histórico aparece quando há atividade" |

**Layout:** tabs no `<PageHeader>` actions OU logo abaixo (Tailwind `border-b border-border`). Cada tab content ocupa `max-w-7xl mx-auto p-5`. Em viewport 1440: tabs ficam full-width; conteúdo em `grid lg:grid-cols-3 gap-5` quando faz sentido (Payments / IBAN) ou `space-y-4` (Timeline/Contacts).

**Navegação:** deep-link via `useSearchParams` L11 + `router.replace('/parties/' + id + '?tab=' + tab)`. Header tab counter via `countFrom*Queries` (cada hook expõe `data?.length ?? 0` no aggregates).

---

## 6. Estimativa

- **Backend:** 12 arquivos
  1. `schema.prisma` (modificação: 2 models + 1 enum + 2 relations)
  2. migration SQL
  3. `party-contacts.controller.ts`
  4. `party-contacts.service.ts`
  5. `dto/party-contact.dto.ts`
  6. `party-addresses.controller.ts`
  7. `party-addresses.service.ts`
  8. `dto/party-address.dto.ts`
  9. `parties.module.ts` (modificação — wires)
  10. `parties.service.ts` (modificação — `sanitizeParty` + `findOne` include)
  11. `timeline/timeline.controller.ts`
  12. `timeline/timeline.service.ts`
  13. `timeline/dto/timeline.dto.ts`
- **Frontend:** 10 arquivos (ver §4 tabela)
- **Testes:** 5 arquivos
  - `party-contacts-crud.spec.ts` (POST/PATCH/DELETE + sanitize)
  - `party-addresses-crud.spec.ts` (idem + isPrimary mutation)
  - `party-addresses-primary-constraint.spec.ts` (race condition test com `Promise.all([setPrimary(type=BILLING), setPrimary(type=BILLING)])`)
  - `timeline-aggregation.spec.ts` (4 fontes + sort desc + cursor pagination)
  - `timeline-cursor.spec.ts` (cursor = null na última página; cursor stale)
- **Data migration** (1 SQL adicional): mover flatten `email/phone/mobile/address/city/postalCode/country` para `PartyContact` (1 row) + `PartyAddress` (1 row type=CORRESPONDENCE isPrimary=true) — opcional
- **TOTAL: ~28 arquivos** — Sprint G é a maior até agora

---

## 7. Risks / Gotchas

| # | Risco | Mitigação |
|---|---|---|
| 1 | **6 tabs em viewport 1440** — Documents/Payments podem querer scroll horizontal | Usar grid responsivo (`lg:grid-cols-2 xl:grid-cols-3` na lista de Documents/Payments); tabs em flex wrap |
| 2 | **Timeline sources com timestamps diferentes** — AuditLog.createdAt, PaymentEvent.createdAt, IbanHistory.createdAt, Document.approvedAt | Normalizar para um campo `at` no DTO antes de merge/sort (ver §5.2) |
| 3 | **`Document.partyId` é nullable** (schema L416). Documentos sem party não devem aparecer no timeline | WHERE filter com `partyId: { not: null }` ou `partyId: id` (ignora null automaticamente) |
| 4 | **`PartyContact.email` unique `[tenantId, partyId, email]`** | Trim e normalizar antes de persistir. Se `email` for `null`, o DB aceita múltiplos null (default Postgres). Se `email` for string vazia, normalizar para `null` na service |
| 5 | **Address isPrimary constraint** | Enforce em transaction + `pg_advisory_xact_lock(hashtext('party_address_primary:' || partyId || ':' || type))` (pattern de H-08 em Sprint E, parties.service.ts já usa) |
| 6 | **Timeline cursor** — 2 eventos no mesmo ms podem ser perdidos se cursor for só timestamp | Cursor composite: `{at: ISO, id: cuid}`. Na query: `OR: [{createdAt: {lt: cursorAt}}, {AND: [{createdAt: cursorAt}, {id: {lt: cursorId}}]}]` — feio mas correto. Alternativa: usar `lt` no createdAt + `orderBy: [{createdAt: 'desc'}, {id: 'desc'}]` |
| 7 | **Frontend tab state + deep-link** | `useSearchParams` → initial tab. `router.replace` em cada tab click (não push, para não poluir history). `searchParams` no Next.js 15 é async — usar `'use client'` + `useSearchParams` corretamente |
| 8 | **Backward-compat dos campos flatten** — `/parties/:id/documents` e `PaymentEvent` não vão mudar. Dados flatten continuam aceitando POST/PATCH mas Sprint G.1 mantém ambos. Sprint G.3 (opcional) deprecate flatten | Anunciar deprecation no `UpdatePartyDto` com `@deprecated` no schema OpenAPI |
| 9 | **Reuso de `PartyIbanPanel`** no tab IBAN — risco de duplicação | O Panel está em `_components/party-detail.tsx`. Extrair conteúdo do risco + history para `iban-tab.tsx`; deixar só os botões verify/flag no `PartyIbanPanel`. **OU** usar o `PartyIbanPanel` inteiro dentro do `iban-tab.tsx` e deletá-lo do layout principal. Decisão do builder (ver §8 #4) |
| 10 | **Migration data migration** (`mover flatten → Contact/Address`) | Sprint G.1 adiciona tabelas vazias + relation opcional. Data migration fica num Sprint G.4 explícito para evitar lock + complexidade no mesmo deploy |
| 11 | **RBAC** — quem pode criar Contact/Address? | Mesmo `Role.ADMIN` (partes são master data, segue padrão do `PATCH /parties/:id`). GET pode ser autenticado sem role gate |
| 12 | **`Tenant` relation** — `PartyContact.tenant` precisa ser adicionado no `Tenant` model também (relation reversa para cascade) | Editar `Tenant` model também — `tenant.contacts PartyContact[]` + `tenant.addresses PartyAddress[]` no schema |
| 13 | **Audit trail das contacts/addresses** (per-field) | Mesmo padrão de `party.update.recurring` (parties.service.ts L459–481): `AuditAction.EDIT` + `metadata.field` + `oldValue/newValue`. Audit por mutação |
| 14 | **Timeline tab infinite scroll + initial load** | `useInfiniteQuery` com `initialPageParam: null`. `getNextPageParam: (lastPage) => lastPage.nextCursor` |

---

## 8. Decisões que o builder vai precisar

1. **Timeline sources — query strategy:**
   - (a) **Promise.all de 4 queries** — simples, retorna ~80 rows por fetch, sort + slice no app. Aceitável para Sprint G. Recomendado. ⚠ o `take: limit` em cada query precisa ser `limit` (não 20) para não cortar cedo — usar `take: limit` e trim final
   - (b) **Cursor único via Prisma union / raw SQL** — mais eficiente mas +50 linhas de raw SQL, ganha-se complexidade cedo demais

2. **`PartyAddressType` enum vs string free?** — **Enum Prisma** (4 valores fixos). UI ganha filtro dropdown consistente e DB tem integridade. Migrate no schema adiciona `enum`

3. **Tab default ao abrir `/parties/[id]`** — **Identity** (continua o flow atual, onde o utilizador acabou de vir da lista e quer editar). Tab Timeline abre quando vier de deep-link `?tab=timeline`

4. **Documentos na tab Documents** — **Reusar `PartyRecentDocuments`** (já existe, é o componente Sprint E). Wrapping mínimo. NÃO criar nova API — `GET /parties/:id/documents` já está exposta no controller L165–197

5. **PaymentEvents — API nova?** — **`GET /parties/:id/payments` NOVA** é o caminho clean (faz JOIN internamente em Document.partyId). Frontend filtra por status. Alternativa: reusar `GET /documents?partyId=...` + deduzir PaymentEvents no client (péssimo). **Recomendado: API nova**

6. **`PartyIbanPanel` reuso** — Opções:
   - (a) Extrair `IbanRiskCard` + `IbanHistoryList` para `_components/iban-tab.tsx` (DRY, mais código)
   - (b) Mover `PartyIbanPanel` inteiro para dentro de `iban-tab.tsx` (mais simples, alguma duplicação futura)
   - (c) Manter `PartyIbanPanel` no layout Identity e duplicar conteúdo no `iban-tab.tsx` (pior opção)
   - Recomendado: (a) — DRY mas com refactor controlado

7. **Data migration Sprint G.1** — **NÃO FAZER** no G.1. Sprint G.4 dedicada com plano explícito (lock? dual-write? backfill?)

8. **Migration de flatten deprecated (email/phone/etc.)** — G.1 mantém ambos. G.2 marca deprecated. G.4 remove

9. **`@deprecated` DTO** — adicionar comentário nos campos flatten de `UpdatePartyDto` + `CreatePartyDto` indicando migração futura

10. **Reuso do `_components/party-detail.tsx`** (que tem o `PartyIbanPanel`) — **refactor mínimo**: extrair ou importar `PartyIbanPanel` de dentro do `iban-tab.tsx`. Aceitar duplicação condicional se a decisão (6) for (b)

---

## 9. Verdict do scout

✅ **READY to plan** — terreno mapeado, modelos a adicionar identificados, contratos de API alinhados com patterns existentes (tenantId via session, `@Roles(ADMIN)` para mutações, sanitize helpers, per-field audit pattern, advisory_xact_lock para races).

⚠ Sprint G é a maior até agora (~28 arquivos). Recomendo **dividir em G.1 + G.2** se o budget de sprint apertar:
- **G.1 (essencial):** models + migrations + Contacts CRUD + Addresses CRUD + tabs Contacts/Addresses/Documents/IBAN + Identity mantida + ajustada em tabs nav (~18 arquivos)
- **G.2 (opcional):** Timeline aggregation + Payments API + Timeline tab + (PartyNote se houver tempo) (~10 arquivos)

Nenhuma edição foi feita — relatório READ-ONLY conforme brief.
