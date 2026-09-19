# Sprint I — Party Enrichment via External APIs (SCOUT)

> **Mission:** map the terrain for Sprint I (party enrichment via Sabi PT + EU VIES, national/foreign branch, supplier + customer re-extraction).
> **Mode:** READ-ONLY. No code changes — only assessment.
> **Source of truth:** commit `097d348` (Sprint H) + `6b4eb64` (Sprint H security fix) on branch `main`.
> **Persona:** Opus 5 fullstack-developer / reviewer.

---

## 1. Estado atual (factual, com file:line)

### 1.1 O que `extraction.service.ts` extrai hoje

**Pipeline central:** `apps/api/src/modules/extraction/extraction.service.ts`.

Campos que o extractor escreve no `Document` (modelo Prisma `Document`, schema:580-501):

| Campo | Fonte típica | Persistido em |
|---|---|---|
| `supplier`, `supplierNif` | QR `A:`, AI/regex, post-merge | `Document.supplier`, `Document.supplierNif` |
| `customer`, `customerNif` | QR `B:`, AI/regex, post-merge | `Document.customer`, `Document.customerNif` |
| `supplierVatId` | regex contra VAT shape table (`supplier-resolver.ts:316-362`) | `ExtractedFields.supplierVatId` (não persistido direto na coluna — só no `metadata.extraction`) |
| `docNumber`, `atcud`, `docDate`, `dueDate` | QR autoritativo | `Document.*` |
| `netAmount`, `taxAmount`, `total`, `currency` | QR autoritativo + AI merge | `Document.*` |
| `iban`, `country` (ISO-3166 alpha-2) | QR/AI/regex | `Document.iban`, `ExtractedFields.country` (não persistido na coluna `Document.country` — guardado em metadata) |
| `lineItems` (AI-only) | `vision.service` | `metadata.extraction.lineItems` |
| `ivaBreakdown`, `isEuIntracommunity`, `suggestedCategory`, `cashDiscountRate`, `discountAmount` | AI-only | `metadata.extraction.*` |

**Importante:** o extractor NÃO popula `email`, `phone`, `mobile`, `address`, `city`, `postalCode`, `website`, `industry` na entidade `Party` — o `SupplierResolver` (sprint E) só cria a `Party` com `name`, `nif`, `iban`, `country`. `apps/api/src/modules/extraction/supplier-resolver.ts:144-156`:

```ts
partyRow = await this.prisma.party.create({
  data: {
    tenantId, type: PartyType.FORNECEDOR,
    name: nameToStore, nif: taxIdToStore, iban: ibanToStore, country: countryCode,
    isActive: true,
  },
  ...
});
```

Ou seja, a ficha do fornecedor fica com NIF + IBAN + nome; o resto é vazio até o utilizador preencher à mão. Este é o gap que Sprint I fecha.

### 1.2 Como `supplier-resolver` matches Party por NIF

**Lookup chain** (`supplier-resolver.ts:217-256`):

1. `(tenantId, nif)` — match PT NIF puro.
2. `(tenantId, nif=vatId, country)` — match VAT prefixado por país.
3. `(tenantId, country, nif contains vatId.slice(2))` — fallback parcial.

**Criação** quando não existe (`supplier-resolver.ts:136-181`): cria `Party` mínimo (sem email/phone/address/etc.), corre `refreshRecurringFlag` (TOCTOU-safe via `updateMany` + `isRecurringManualOverride` gate — auditoria sprint E).

**Race protection:** se dois uploads paralelos tentarem criar a mesma Party, o segundo cai no `lookupParty` de recúo (linha 161-179) e reusa a que ficou primeiro. Validação `isTaxIdValid` é a tabela `viesShapeMatches` inline (linhas 330-362) — não chama VIES, só regex de shape.

### 1.3 Que campos a Party TEM no schema vs quais são preenchidos hoje

**Schema `Party`** (`apps/api/prisma/schema.prisma:580-660`):

| Coluna | Tipo | Preenchido hoje? |
|---|---|---|
| `name` | String | **Sim** — pelo resolver |
| `nif` | String? | **Sim** — PT 9 dígitos / VAT prefixado |
| `email`, `phone`, `mobile` | String? | ❌ vazio |
| `iban`, `bic` | String? | **Sim** pelo resolver quando válido |
| `address`, `city`, `postalCode` | String? | ❌ vazio |
| `country` | String @default("PT") | **Sim** — código país |
| `website`, `industry` | String? | ❌ vazio |
| `notes`, `tags` | String? / String[] | ❌ vazio |
| `paymentTermDays` | Int? @default(30) | default |
| `externalIds` | Json? | ❌ vazio |
| `ibanVerified`, `ibanVerifiedAt`, `ibanRiskScore`, `ibanFlagged` | fraud fields | geridos pelo IBAN module |
| `isRecurring`, `isRecurringManualOverride` | Boolean | sim — pelo resolver |
| `slug` | String? | sim — sprint E |
| `partyCategoryId` | String? | sprint E — opcional |

**Não existe** coluna `enrichedAt`. Sprint I precisa adicioná-la (DDL simples, nullable).

### 1.4 O que a ficha do Party mostra hoje no UI (`/parties/[id]`)

**Página:** `apps/web/app/(dashboard)/parties/[id]/page.tsx` — Sprint G 360° file, **6 tabs**:

1. **Identidade** (default) — `<PartyForm initial={initial}>` lê `email`, `phone`, `mobile`, `iban`, `bic`, `address`, `city`, `postalCode`, `country`, `defaultDebitAccountId`, `defaultCreditAccountId`, `isRecurring`, `isRecurringManualOverride` (page.tsx:57-74).
2. **Contacts** — `ContactsTab` (`contacts-tab.tsx`, 10.4 KB) — Sprint G sub-resources.
3. **Documents** — `DocumentsTab` (FORNECEDOR only, lista faturas recentes).
4. **Payments** — `PaymentsTab` (PaymentEvent list).
5. **IBAN** — `IbanTab` (risk donut + history + verify/flag).
6. **Timeline** — `TimelineTab` (agregação de AuditLog + IbanHistory + Documents + Contacts).

A tab "Identidade" é editável via `<PartyForm>` e PATCH `/parties/:id` (ADMIN-only, `@Roles(Role.ADMIN)` no controller:200). O PATCH aceita TODOS os campos acima via `UpdatePartyDto`.

**Botão "Re-extrair dados" NÃO existe** — a única ação hoje na ficha é editar manualmente.

### 1.5 Estado atual do pipeline Sprint H

**Arquitetura:** `apps/api/src/modules/documents/processing/processing.service.ts`.

**4 estágios + handlers (TODOS idempotentes):**
- `handleReceived` (RECEIVED → EXTRACTING) — dispara `extraction.enqueue(...)` na linha 204.
- `handleExtracted` (EXTRACTING → ENRICHING).
- `handleEnriched` (ENRICHING → ROUTING) — auto-approve gate se `tenant.settings.autoApprove` AND `doc.partyId`.
- `handleRouted` (ROUTING → COMPLETED).

**`@Throttle + per-doc cap + 20s keepalive` no SSE** (`processing.controller.ts`).

**Estado REAL do pipeline hoje (achado importante para Sprint I):**

❌ **`document.extracted` NÃO é publicado em lado nenhum.** O `extraction.service.processDocumentAsync` retorna resultado mas não chama `this.queue.publish(...)`. `grep "publish" extraction.service.ts` → 0 hits. Confirmado em `apps/api/src/modules/extraction/extraction.service.ts` linhas 430-984 (processDocumentAsync).

❌ **`document.enriched` também não é publicado** — o `handleEnriched` (processing.service:268) só roda se algo emitir o evento, e nada emite.

Isto significa que **o pipeline ENRICHING → ROUTING está conectado mas desligado**. O `handleReceived` faz o upload→EXTRACTING e dispara `extraction.enqueue`, mas a transição EXTRACTING→ENRICHING depende de alguém publicar `document.extracted` depois da extraction terminar. O documento fica preso em EXTRACTING forever (ou até alguém fazer PATCH manual que dispare algo).

**Implicação Sprint I:** o briefing diz "automático no stage 3 (enrich)". Sprint I **precisa de uma sub-tarefa extra** antes de enrich: ligar a publicação do `document.extracted` (provavelmente na última linha de `processDocumentAsync`, perto de onde hoje retorna `ExtractionJobResult`). Sem isso o enrich manual via botão é a única via viável.

### 1.6 Onde mora o estado de "ENRICHING em curso" no UI

**Arquivo:** `apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx` — cliente que subscreve `/api/v1/documents/:id/processing/stream` via SSE.

`ProcessingStage` type (linhas 33-39) cobre `RECEIVED | EXTRACTING | ENRICHING | ROUTING | COMPLETED | FAILED`. **Não há sub-estado para "external lookup"** — Sprint I pode precisar de um campo opcional `subAction?: 'enriching_external'` no payload, ou renderizar a cópia "A enriquecer dados externos…" baseada em `metadata.party.enrichmentInFlight`.

### 1.7 Helpers sprint E referenciados pelo briefing que NÃO existem

- `apps/api/src/common/storage/path-builder.ts` — **NÃO existe**. Só `slug.ts` (linhas 1-31) está nesse diretório. O sprint E guardou o slugify em `parties.service.generateUniqueSlug` (parties.service.ts:1194-1205). **Briefing está desatualizado.**

- `apps/api/src/common/storage/slug.ts` — existe, é o helper real.

---

## 2. Decisões pré-confirmadas (aceitar como contrato)

1. **Módulo `enrichment/` com APIs externas:**
   - Sabi PT (NIF PT → dados empresa)
   - VIES (VAT UE → valida + nome + morada)
   - OpenCorporates / Companies House GB — opcional fora do MVP
2. **Classificação automática por IBAN prefix / `country`:**
   - `country=='PT'` ou `iban.startsWith('PT50')` → Sabi PT
   - IBAN prefix UE (ES/FR/DE/IT/NL/BE/LU/AT/IE/FI/GR/PT) → VIES
   - Fora UE → ManualProvider (no-op + log "manual enrichment needed")
3. **Customer enrichment** segue o mesmo fluxo (usar `Document.customer`, `Document.customerNif`, `Document.customerVatId` em vez dos campos supplier). `Document.customer === Tenant.name` é a heurística para detectar se é o próprio tenant (e pular enrichment).
4. **Trigger:** manual via botão "Re-extrair dados" em `/parties/[id]` + automático no stage 3 ENRICHING do pipeline — **mas a parte automática está desligada hoje** (§1.5).

---

## 3. Backend touchpoints

| # | Arquivo | Mudança | Estado |
|---|---|---|---|
| 1 | `apps/api/src/modules/enrichment/` (novo) | `enrichment.service.ts` (orquestra), `enrichment.controller.ts` (`POST /parties/:id/enrich`), `enrichment.module.ts` | NOVO |
| 2 | `apps/api/src/modules/enrichment/providers/` (novo) | `sabi-pt.provider.ts`, `vies.provider.ts`, `manual.provider.ts` | NOVO |
| 3 | `apps/api/src/modules/enrichment/providers/factory.ts` | provider factory: country/iban → provider | NOVO |
| 4 | `apps/api/src/modules/parties/parties.service.ts` | método público `applyEnrichment(tenantId, partyId, payload)` que **só escreve nos campos vazios** (preserva override humano) | MODIFICAR |
| 5 | `apps/api/src/modules/documents/processing/processing.service.ts` `handleEnriched` | APÓS enrich, atualizar Party; se `party.enrichedAt` é null OU > 30d, dispara enrichment | MODIFICAR |
| 6 | `apps/api/src/modules/documents/processing/processing.module.ts` | importar `EnrichmentModule` (forwardRef se necessário) | MODIFICAR |
| 7 | `apps/api/src/app.module.ts` | registrar `EnrichmentModule` | MODIFICAR |
| 8 | `apps/api/.env` | `SABI_PT_API_KEY`, `VIES_API_ENDPOINT` (público) | MODIFICAR |
| 9 | `apps/api/src/modules/extraction/extraction.service.ts` | **publicar `document.extracted` no fim de `processDocumentAsync`** — pré-requisito para o stage 3 do pipeline funcionar | MODIFICAR |
| 10 | `apps/api/prisma/schema.prisma` | `Party.enrichedAt DateTime?`, `Party.enrichmentSource String?`, `Party.enrichmentError String?` | MODIFICAR (DDL via `prisma migrate dev`) |

**Notas críticas:**
- `parties.service.update` já cobre a escrita de TODOS os campos do enrichment (email, phone, address, city, postalCode, website, industry). Sprint I não precisa duplicar a escrita — pode invocar `update` com um `UpdatePartyDto` parcial. Mantém a auditoria (linha 455-466).
- Para preservar overrides humanos, o enrich NUNCA deve sobrescrever um campo que já está preenchido na `Party` — usa "only fill nulls" semantic.
- Audit row: reusar `AuditAction.EDIT` com `metadata.subAction = 'party.enrich'` + `metadata.source = 'sabi-pt' | 'vies' | 'manual'` + `metadata.fieldsPopulated = ['email', 'address', ...]` — padrão igual ao sprint E.

---

## 4. Frontend touchpoints

| # | Arquivo | Mudança | Notas |
|---|---|---|---|
| 1 | `apps/web/app/(dashboard)/parties/[id]/_components/party-form.tsx` (ou um botão novo na tab Identidade) | botão "Re-extrair dados externos" — `POST /parties/:id/enrich` com loading state | `party-form.tsx` é o ponto natural; confirmar a UI header tab |
| 2 | `apps/web/app/(dashboard)/parties/[id]/page.tsx` | adicionar badge "Enriched at <timestamp>" + "Last enriched: never" se nunca correu | adicionar ao `PageHeader` actions |
| 3 | `apps/web/app/(dashboard)/parties/[id]/_hooks/use-enrich-party.ts` (novo) | TanStack Query mutation que chama o endpoint + invalida `['party', id]` | igual ao padrão `useReExtract` em `documents/[id]` |
| 4 | `apps/web/app/(dashboard)/documents/[id]/_components/field-panel.tsx` | adicionar link "Ver ficha completa do fornecedor" se `doc.hasParty` (= `doc.partyId != null`) | abrir em nova tab / router push |
| 5 | `apps/web/app/(dashboard)/documents/[id]/page.tsx` | mostrar email/phone/morada do **Party** linkado, não do `Document` flat (que hoje é vazio) | requer o hook do doc-detail carregar o Party linkado |
| 6 | `apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx` | durante `ENRICHING`, mostrar "A enriquecer dados externos" se houver um sub-flag `externalInFlight` (precisa de pequeno schema change no payload SSE) | opcional — pode ser adiado |

---

## 5. Detalhes técnicos Sprint I

### 5.1 Provider factory

```typescript
type EnrichmentProvider = 'sabi-pt' | 'vies' | 'manual';

function pickProvider(country: string | null, iban: string | null): EnrichmentProvider {
  if (!country && !iban) return 'manual';
  if (country === 'PT' || iban?.toUpperCase().startsWith('PT50')) return 'sabi-pt';
  const UE = ['ES','FR','DE','IT','NL','BE','LU','AT','IE','FI','GR','PT','CY','MT','SI','SK','CZ','HU','PL','RO','BG','HR','SE','DK','EE','LV','LT'];
  if (country && UE.includes(country.toUpperCase())) return 'vies';
  if (iban) {
    const prefix = iban.slice(0, 2).toUpperCase();
    if (UE.includes(prefix)) return 'vies';
  }
  return 'manual';
}
```

### 5.2 Sabi PT API (endpoint confirmado por docs públicas)

- Endpoint público: `https://www.sabi.pt/api/companies/{nif}`
- Auth: header `Authorization: Bearer <SABI_PT_API_KEY>`
- Resposta típica: `{ name, address, postalCode, city, phone, email, website, cae, nace, status }`
- Rate limit: ~1 req/s (free tier), 5 req/s (paid ~€20/mês)
- Cache recomendado: `Map<partyId, { data, expiresAt }>` em memória + opcional Redis

### 5.3 VIES (VAT Information Exchange System)

- Endpoint público: `https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number-service`
- Sem auth (público, rate limited — generoso mas não documentado)
- SOAP/XML, mas a library `vies` no npm encapsula. Alternativa: Postman tem REST wrapper documentado.
- Request: `{ countryCode, vatNumber }` → `{ valid, name, address, requestIdentifier }`
- Timeout: 5s (DOCFLOW recomenda cap agressivo porque VIES tem micro-outages)

### 5.4 Enrichment no pipeline (`handleEnriched`)

```typescript
// pseudo-código — insert dentro do txn existente ou como sub-tx
const party = await tx.party.findFirst({ where: { id: doc.partyId, tenantId }, select: { id: true, nif: true, iban: true, country: true, enrichedAt: true } });
if (party) {
  const fresh = !party.enrichedAt || (Date.now() - party.enrichedAt.getTime()) > 30 * 86400_000;
  if (fresh) {
    // enqueue async, NÃO no txn (Sabi/VIES não podem segurar lock)
    // publicar document.enriched via QueueAdapter quando terminar
    await this.enrichment.enqueue({ tenantId, partyId: party.id });
  }
}
```

O `enrichment.service` deve usar o mesmo padrão FIFO in-memory que `extraction.service` (§`syncQueueTail` em extraction.service.ts:263-415) para evitar corrida quando Redis cai.

### 5.5 Customer enrichment

Heurística para detetar "customer é o próprio tenant":
```typescript
const isCustomerTenant = doc.customer && tenant.name &&
  doc.customer.toLowerCase().trim() === tenant.name.toLowerCase().trim();
// ou usa o tenant NIF se a Doc tem tenant NIF exposto
```

Se `isCustomerTenant === true` → pular enrichment (não vale a pena enriquecer a si próprio).

Sprint I precisa expor `Document.customer` + `Document.customerNif` + `Document.customerVatId` na API de enrichment (criar DTO `EnrichmentRequestDto { partyId?, documentId?, role: 'supplier' | 'customer' }`).

### 5.6 Preservar overrides humanos

Regra crítica: o enrich NUNCA sobrescreve campos não-nulos. Apenas preenche `null`s. Isto evita que um re-run "estrague" uma morada que o operador corrigiu manualmente.

```typescript
const merged: Record<string, unknown> = {};
for (const field of ['email','phone','mobile','address','city','postalCode','website','industry']) {
  if (existingParty[field] == null && enrichedData[field] != null) {
    merged[field] = enrichedData[field];
  }
}
```

---

## 6. Estimativa

| Categoria | Arquivos | LOC (estimativa) |
|---|---|---|
| Backend — módulo enrichment | 4 (module/controller/service + index) | ~250 |
| Backend — providers | 4 (sabi/vies/manual/factory) | ~400 |
| Backend — DTOs | 2 (enrichment-request + enrichment-response) | ~80 |
| Backend — testes | 4 (factory, sabi, vies, manual) | ~350 |
| Backend — wiring | 3 (app.module, processing.service edit, extraction.service edit para publicar `document.extracted`) | ~80 |
| Frontend — botão + badge | 2 (use-enrich-party + party-form edit + page badge) | ~150 |
| Frontend — link field-panel | 1 (field-panel edit) | ~30 |
| Frontend — link no doc detail | 1 (page.tsx) | ~20 |
| DB migration | 1 (`prisma migrate dev --name add_party_enrichment`) | ~20 |
| **TOTAL** | **~22 arquivos** | **~1380 LOC** |

---

## 7. Risks (avaliação crítica)

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| 1 | **Pipeline desliga-do** — `document.extracted` nunca é publicado, então `handleEnriched` nunca corre. | **BLOQUEANTE** para a parte automática. | Adicionar publicação em `extraction.service.processDocumentAsync` no fim, antes do `return { ... }`. Cobertura: tests existentes em `processing-pipeline.spec.ts` devem ser estendidos. |
| 2 | Sabi PT / VIES outage / rate limit | Médio | Timeout agressivo (5s), fallback `ManualProvider`, audit row com `enrichmentError` para retry |
| 3 | VIES em SOAP/XML vs Node fetch (REST não trivial) | Médio | Usar lib `vies` npm ou fazer request XML manual com `xml2js`. Alternative: Postman mock layer. |
| 4 | GDPR — armazenar dados públicos de empresas PT/UE | Baixo | Dados públicos de registos comerciais são base legal legítima (interesse legítimo) — registrar no DPA do tenant |
| 5 | Custos Sabi PT | Baixo | Free tier 100 lookups/mês é suficiente para MVP. Paid tier €20/mês para 1000 lookups só se necessário. |
| 6 | IBAN parsing — extrair country code | Baixo | Já temos `normalizeIban` no `@docflow/shared` — chars 0-1 do IBAN normalizado |
| 7 | Re-rodar enrichment sobre dados já editados pelo humano | Médio | "Only fill nulls" rule (§5.6) — audit row mostra `fieldsPopulated` |
| 8 | Race entre auto-enrich (pipeline) e manual button (UI) | Médio | Lock por `partyId` via `pg_advisory_xact_lock(hashtext('enrich:' || partyId))` — reusar padrão `docLockKey` (`common/locks.ts`) |
| 9 | VIES/Sabi retornam campos vazios para empresas inativas/dissolvidas | Baixo | Audit row com `enrichmentError: 'no_data'`, UI badge "Sem dados externos disponíveis" |
| 10 | O factory pode escolher provider errado se IBAN != country | Baixo | Trust country code primeiro; IBAN como tie-breaker. Log de `providerDecision` para auditoria. |

---

## 8. Decisões que o builder vai precisar

1. **Auto vs manual no pipeline?** Recomendado: **híbrido** — auto no stage 3 só se `party.enrichedAt is null OR > 30d`. Manual via botão sempre disponível. (Briefing do user confirma esta abordagem.)

2. **Manual provider para extra-UE:** retorna `{ status: 'manual_required', reason: 'extra_eu_no_api' }` e loga `enrichmentError: 'manual_required'`. Não tenta OpenCorporates no MVP.

3. **Rate limit handling:** exponential backoff com jitter (3 retries: 1s, 2s, 4s) + queue persistente se Redis up. Sync fallback FIFO (mesmo padrão do extraction.service.ts:263).

4. **GDPR consent:** não precisa de banner — dados públicos de registos comerciais. Documentar no DPA do tenant.

5. **Cache strategy:** in-memory `Map<partyId, { data, expiresAt }>` em `EnrichmentService` (TTL 30d, alinhado com o gate). Redis opcional em V2.

6. **DB schema change:** adicionar `Party.enrichedAt`, `Party.enrichmentSource`, `Party.enrichmentError` — todos nullable, sem default.

7. **Public API surface:** `POST /parties/:id/enrich` (RBAC ADMIN OU OPERADOR, idempotente, retorna `{ source, fieldsPopulated, fetchedAt }`).

8. **Event publication:** Sprint I **precisa** adicionar publication de `document.extracted` em `extraction.service.processDocumentAsync` (últimas linhas antes do `return`) — sem isto, o stage 3 nunca dispara.

---

## 9. Ficheiros lidos (evidence)

```
apps/api/src/modules/extraction/extraction.service.ts                  (full, 4005 LOC)
apps/api/src/modules/extraction/supplier-resolver.ts                   (full, 391 LOC)
apps/api/src/modules/documents/processing/processing.service.ts        (full, 558 LOC)
apps/api/src/modules/documents/processing/processing.module.ts         (full, 41 LOC)
apps/api/src/modules/parties/parties.service.ts                        (full, 1212 LOC)
apps/api/src/modules/parties/parties.controller.ts                     (full, 399 LOC)
apps/api/prisma/schema.prisma                                          (full, 1411 LOC)
apps/api/src/common/storage/slug.ts                                    (full, 31 LOC)
apps/web/app/(dashboard)/documents/[id]/_components/field-panel.tsx   (full, 1321 LOC)
apps/web/app/(dashboard)/documents/[id]/page.tsx                       (full, 749 LOC)
apps/web/app/(dashboard)/parties/[id]/page.tsx                         (full, 160 LOC)
apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx (first 120 LOC)
```

**Ficheiros referenciados pelo briefing que NÃO existem:**
- `apps/api/src/common/storage/path-builder.ts` — NÃO EXISTE. Briefing desatualizado.
- `apps/api/src/common/storage/slug.ts` — EXISTE (helper real).

**Comandos auxiliares:**
- `grep "publish" extraction.service.ts` → 0 hits (confirma §1.5)
- `ls apps/web/app/(dashboard)/documents/[id]/_components/` → `document-viewer.tsx, field-panel.tsx, fraud-warning.tsx, qr-badge.tsx, processing-status.tsx`
- `ls apps/web/app/(dashboard)/parties/[id]/_components/` → `addresses-tab.tsx, contacts-tab.tsx, documents-tab.tsx, iban-tab.tsx, party-recent-documents.tsx, party-tabs.tsx, payments-tab.tsx, timeline-tab.tsx`

---

## 10. Verdict para o builder

**READY TO BUILD** — com um pré-requisito MUST-FIX antes da parte automática:

> **Antes de Sprint I, adicionar a publicação de `document.extracted` em `apps/api/src/modules/extraction/extraction.service.ts:processDocumentAsync` (linhas 430-984).** Sem isto o pipeline stage 3 ENRICHING nunca dispara, e o enrich "automático" do briefing não passa de uma intenção. Pode ser adiado para Sprint I.1 (sub-tarefa de 30 min).

Tudo o resto (factory, providers, controller, frontend, badge, link) está bem mapeado e não toca em arquitetura crítica.

**Próximo passo recomendado:** Sprint I.0 = adicionar publication de `document.extracted` (15 LOC + 1 test). Sprint I.1 = módulo enrichment. Sprint I.2 = botão + badge + link UI. Sprint I.3 = DDL + migration + cache in-memory.
