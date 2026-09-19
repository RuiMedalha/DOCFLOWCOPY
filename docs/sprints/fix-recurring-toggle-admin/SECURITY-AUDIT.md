# SECURITY AUDIT — diff 077d55b + merge 5d5aa3f
## `feat(party): ADMIN toggle for isRecurring with manual override`

**Mission:** `Lx6BX4G1C2xb` · **Folder:** `fix-recurring-toggle-admin/` · **Date:** 2026-09-03 · **Branch:** `main` · **HEAD:** `5d5aa3f` · **Reviewer:** SECURITY-AUDITOR (Opus 5)

**Verdict:** 🟢 **NO BLOCKER, ONE MEDIUM GAP, TWO LOW FINDINGS.** The change is well-defended at the route level (RbacGuard global + Roles decorator) AND the service level (defense-in-depth ForbiddenException), and the Prisma tenant-extension guarantees no cross-tenant leakage even when the supplier-resolver omits an explicit `tenantId` filter.

**Skill load contract:** `oc-api-audit` and `oc-billing-webhooks` returned `Unknown` from the Skill tool — auditor proceeded with a caseira audit (documented here per the skill-load contract so the caller can see the gate was attempted, not bypassed silently).

---

## 1. AUTH/RBAC — ✅ CLEAN

| Check | Status | Evidence |
|---|---|---|
| `@Roles(Role.ADMIN)` aplicado no `@Patch('parties/:id')` | ✅ | `apps/api/src/modules/parties/parties.controller.ts:200` |
| `RbacGuard` registado como `APP_GUARD` | ✅ | `apps/api/src/app.module.ts:140` — `{ provide: APP_GUARD, useClass: RbacGuard }` (último da cadeia global, depois de JwtGuard+TenantGuard) |
| Ordem dos guards globalmente | ✅ | ThrottleBucketGuard(136) → JwtGuard(138) → TenantGuard(139) → RbacGuard(140) — RbacGuard roda APÓS Jwt/Tenant, então só vê users autenticados e tenant-scoped. Decorator sozinho não é no-op. |
| Defesa em profundidade no service | ✅ | `apps/api/src/modules/parties/parties.service.ts:267-272` — `ForbiddenException` se `userRole !== 'ADMIN'` E alguém passou `isRecurring`/`isRecurringManualOverride` |
| Decorator `Roles` corretamente implementado | ✅ | `apps/api/src/common/decorators/roles.decorator.ts:16` — SetMetadata padrão; `RbacGuard` (rbac.guard.ts:43-55) lê via Reflector e checa `user.roles` (Set membership) |

**Verificação crítica (JwtGuard ↔ RbacGuard contract):**
- `JwtGuard.canActivate` (`apps/api/src/common/guards/jwt.guard.ts:58-63`) popula `request.user = { ...payload, id, tenantId, role: payload.roles?.[0] }`. Note que `payload.roles` é ARRAY (DocFlowJwtPayload.roles) e é spreaded — então `request.user.roles` também é o array original. `RbacGuard` (rbac.guard.ts:52) usa `new Set(user?.roles ?? [])` ✓.
- `parties.service.update` (parties.service.ts:269) usa `user.role === 'ADMIN'` (string singular, vindo de `payload.roles[0]` no JwtGuard ou do AuthenticatedUser.role no JwtStrategy.validate). Quando `@CurrentUser()` é invocado no controller, o JwtStrategy.validate substitui `request.user` com AuthenticatedUser (single `role`) — mas **JwtGuard canActivate re-escreve `request.user` por cima**, então o que RbacGuard vê na verdade é o objeto JwtGuard (com `roles: array` E `role: string`). Compatível em ambas as direções. ✓

**Sem bypass conhecido:**
- Grep confirma que `parties.update()` é invocado **apenas** de `parties.controller.ts:217`. Nenhum caller interno (queue/cron) chama o service method diretamente. A defesa em profundidade é, portanto, redundante HOJE — mas é uma salvaguarda sólida para o futuro (qualquer novo consumer interno que esquecer o guard é apanhado).
- `PartiesService.update()` é instanciado em `parties.module.ts:25` e só exportado pelo mesmo módulo — DI scoping torna impossível outro módulo instanciar sem autorização.

---

## 2. TENANT ISOLATION — ✅ CLEAN

| Check | Status | Evidence |
|---|---|---|
| `PartiesService.update` filtra por `tenantId` no find/update | ✅ | `parties.service.ts:251-252` — `where: { id, tenantId }`. `where: { id }` no `party.update` (L365/368) é auto-scoped pelo Prisma extension. |
| `supplier-resolver.refreshRecurringFlag` filtra por `tenantId` | ✅ (via Prisma extension) | `supplier-resolver.ts:273-276` usa `where: { id: partyId }` (SEM tenantId explícito), MAS `apps/api/src/prisma/prisma.service.ts:181-188` re-escreve o where para `mergeTenantFilter(a.where, tenantId)` automaticamente para modelos em `TENANT_SCOPED_MODELS` (que inclui `Party` em L19). Mesmo o `document.count` em L281 (`where: { tenantId, partyId }`) é redundante com a injeção automática — belt and braces. |
| Sanitização `findFirst` no supplier-resolver | ✅ | O read inicial em L273-276 está dentro do `try` do `resolve()` (L96-209), portanto executa sob o TenantContext do request — Prisma extension injeta `tenantId` antes da query sair. |

**Cross-tenant attack surface — none.** Um ADMIN de tenant A NÃO consegue afetar uma party de tenant B porque: (a) o PATCH filtra por `{id, tenantId}` no find; (b) o `update` é auto-scoped; (c) o `refreshRecurringFlag` roda sob o mesmo TenantContext.

---

## 3. AUTHORIZATION vs AUTHENTICATION — ✅ CLEAN

- JWT payload inclui `tenant_id`, `roles[]` (array) e `sub` (DocFlowJwtPayload em `apps/api/src/common/guards/jwt.guard.ts:11-21`).
- JwtStrategy.validate (`apps/api/src/modules/auth/strategies/jwt.strategy.ts:44-75`) verifica `payload.sub` existe, usuário `isActive`, sem `deletedAt`, e **tenantId do user === payload.tenant_id** (L62-64 — defesa contra tokens reusados de outra sessão). ✓
- `@CurrentUser()` decorator (`apps/api/src/modules/auth/decorators/current-user.decorator.ts:8-15`) simplesmente retorna `request.user` ou pluck por chave. Não confia em dado cru — recebe o objeto já validado pelo guard chain. ✓

---

## 4. INPUT VALIDATION — ✅ CLEAN

| Check | Status | Evidence |
|---|---|---|
| `isRecurring` tem `@IsBoolean()` | ✅ | `apps/api/src/modules/parties/dto/party.dto.ts:169-171` — `@IsOptional() @IsBoolean() isRecurring?: boolean;` |
| `isRecurringManualOverride` tem `@IsBoolean()` | ✅ | `party.dto.ts:177-179` |
| Coerção de string `"true"` / number `1` | ✅ (rejeitado = safe default) | Sem `@Type(() => Boolean)` no DTO body (compare com `PartyQueryDto.isActive` em L197-199 que TEM a coerção). Se o cliente mandar `{isRecurring: "true"}` ou `{isRecurringManualOverride: 1}`, class-validator REJEITA com 400 — comportamento correto para flags que controlam estado sensível. Strings `true`/`false`/`1`/`0` são explicitamente NÃO auto-coerced; isso evita que um client bug ou atacante mande uma string maliciosa esperando coerção. |
| `PartialType(CreatePartyDto)` propaga validators? | ⚠ NOTA | `PartialType` adiciona `@IsOptional()` a todos os campos do parent e os torna opcionais, mas **não** propaga os validators já declarados quando usados na classe pai — porém, neste caso, ambos os campos (`isRecurring`, `isRecurringManualOverride`) estão declarados diretamente em `UpdatePartyDto` (L166-179), não herdados. Não há bug. |

---

## 5. RACE CONDITIONS — 🟡 MEDIUM (TOCTOU em supplier-resolver)

### 5.1 `parties.update` (concurrent ADMIN writes) — ✅ ACEITÁVEL
- Dois ADMINs PATCHando `isRecurringManualOverride` em paralelo: last-write-wins. Como o estado é uma flag binária e ambos os writers são ADMIN, não há privilégio envolvido. **Não é finding.**
- O `$transaction` (parties.service.ts:367-381) cobre o caso IBAN-change, mas o `audit.log` em L384 está fora da transação. O audit log já é best-effort por design (audit.service.ts:96 swallow-on-error); portanto não há inconsistência observável.

### 5.2 `refreshRecurringFlag` — TOCTOU — 🟡 MEDIUM

**Arquivo:** `apps/api/src/modules/extraction/supplier-resolver.ts:265-298`
**Cenário:**
1. Extraction começa; `refreshRecurringFlag` chama `party.findFirst({ where: { id: partyId }, select: { isRecurringManualOverride, isRecurring } })` em L273-276 → lê `override=false`.
2. **Entre o SELECT e o UPDATE seguinte**, outro ADMIN faz `PATCH /parties/:id {isRecurringManualOverride:true}` (commit).
3. O auto-flip continua: `shouldRecur=true` (>=3 docs), `party.update({ where: { id: partyId }, data: { isRecurring: true } })` em L287-290 — **SOBRESCREVE** o override que o ADMIN acabou de ligar, e pior, **não respeita** a decisão do ADMIN de manter o `isRecurring` atual.

**Impacto real:** O ADMIN liga o override pretendendo travar o valor atual (por exemplo, ele acabou de desligar uma `isRecurring=true` porque o fornecedor virou pontual, e quer que o auto-flip NÃO religue). Se a janela TOCTOU coincide com uma extração em curso, o auto-flip religa. ADMIN precisa religar o override de novo. UX ruim, não é escalada de privilégio — **mas é inconsistência comportamental que contradiz o contrato declarado na SCOUT-REPORT** ("Override ADMIN — isRecurring travado, auto-flip pausado").

**Gravidade:** MEDIUM. Não é um bypass de segurança (ADMIN está apenas sendo ignorado por uma janela curta), mas viola o invariante declarado.

**Mitigação recomendada:**
- Opção A (preferida): `refreshRecurringFlag` deve fazer o `party.update` com **conditional where** — `updateMany({ where: { id: partyId, isRecurringManualOverride: false }, data: { isRecurring: true } })`. O `updateMany` retorna `count` — se for 0, o override foi ligado no meio-tempo e o caller respeita. Isto é uma operação atômica no DB.
- Opção B (alternativa): envolver o SELECT + UPDATE num `prisma.$transaction` com `SERIALIZABLE` isolation (mas Prisma nem sempre suporta isso; e adiciona retries).
- Opção C (mínima): adicionar retry loop no supplier-resolver — após o `update`, re-ler `isRecurringManualOverride` e, se true, reverter. Adiciona round-trips.

**Recomendação:** Opção A. Mínimo de código, atomicidade no DB, mantém a interface.

---

## 6. AUDIT LOG — 🟡 MEDIUM GAP

**Verificação:**
- `PartiesService.update` (`parties.service.ts:384-395`) escreve audit log APÓS o `update` com `action: AuditAction.EDIT`, `entityType: 'party'`, e metadata **apenas `{ ibanChanged, oldIban, newIban }`**.
- Mudanças em `isRecurring` ou `isRecurringManualOverride` **NÃO são gravadas na metadata**.
- Portanto: **não há rastro auditável** de quem ligou/desligou o override, quando, nem o valor antes/depois.

**Impacto:**
- Em caso de disputa ("eu desliguei e alguém religou atrás de mim"), não há como provar.
- Compliance/audit externo pode exigir que toggles ADMIN sejam logados; este diff falha o requisito.
- A coluna `IbanHistory` mantém audit trail de IBAN changes — por que não manter um equivalente para `isRecurringManualOverride`?

**Gravidade:** MEDIUM. Não é vazamento/exploit, mas é um gap de accountability. Pode ser resolvido com 3 linhas:
```ts
metadata: {
  ibanChanged,
  oldIban: existing.iban ?? null,
  newIban: ibanChanged ? (sanitizedIban as string) : null,
  isRecurring: dto.isRecurring,
  isRecurringManualOverride: dto.isRecurringManualOverride,
},
```

**Recomendação:** estender metadata do audit log para incluir os toggles alterados. Considerar um modelo `PartyRecurringAudit` separado (estilo `IbanHistory`) se o histórico longo for desejado.

---

## 7. INFORMATION DISCLOSURE — 🟢 LOW

**Verificação:**
- `sanitizeParty` (`parties.service.ts:999-1014`) usa spread `...p` que propaga `isRecurringManualOverride` para TODOS os roles que lerem uma party.
- Frontend (`parties-list.tsx:75-90`) renderiza o badge âmbar para todos os usuários, baseado em `p.isRecurringManualOverride`.

**Análise:**
- O campo em si não é sensível (não vaza PII, segredos, ou dados confidenciais) — é apenas um boolean que indica "ADMIN travou o auto-flip".
- A divulgação é *consistente com a UX* (o badge é público). Ocultar no backend seria inconsistente com o que o frontend já mostra.
- Não é vector de privilege escalation.

**Gravidade:** LOW. Documentado como decisão consciente (UX > strict hide). Nenhuma ação obrigatória; marcar apenas para registro.

**Recomendação opcional:** se o time decidir que OPERADOR/GESTOR_RH não precisam ver o status de override (pode causar "por que esse fornecedor tem badge diferente? — o ADMIN fez algo?"), introduzir `sanitizePartyForRole(p, userRole)` que omite `isRecurringManualOverride` para non-ADMIN. Decisão de produto, não de segurança.

---

## 8. MIGRAÇÃO — ✅ CLEAN

- `apps/api/prisma/migrations/20260903000000_add_recurring_override/migration.sql` — única statement, `ALTER TABLE "parties" ADD COLUMN "isRecurringManualOverride" BOOLEAN NOT NULL DEFAULT false;`.
- `NOT NULL DEFAULT false` → **atômica** em PostgreSQL (default aplicado a todas as rows existentes na mesma statement; nenhum SELECT antes do ALTER pode falhar).
- Schema (`schema.prisma:589`) tem `@default(false)` para o Prisma Client. ✓
- Caveat conhecido (SCOUT-REPORT §8.1): a migração anterior `20260831000001_party_is_recurring` é `SELECT 1;` placeholder — Prisma pode reclamar de drift. Builder tratou com `--create-only` + SQL manual. Não é blocker. ✓

---

## 9. SUMÁRIO EXECUTIVO

| # | Finding | Severity | File:Line | Fix Effort |
|---|---|---|---|---|
| 5.2 | TOCTOU: `refreshRecurringFlag` pode sobrescrever override ADMIN recém-ligado entre SELECT e UPDATE | 🟡 MEDIUM | `apps/api/src/modules/extraction/supplier-resolver.ts:265-298` | XS (5 min — usar `updateMany` com `where: { id, isRecurringManualOverride: false }`) |
| 6 | Mudanças em `isRecurring` / `isRecurringManualOverride` NÃO vão pro audit log | 🟡 MEDIUM | `apps/api/src/modules/parties/parties.service.ts:384-395` | XS (3 min — estender metadata) |
| 7 | `isRecurringManualOverride` é exposto a todos os roles via `sanitizeParty` e via UI badge | 🟢 LOW | `apps/api/src/modules/parties/parties.service.ts:999-1014` + frontend | M (UX decision + possible role-based sanitizer) |

**Smoke tests NÃO executados** — ambiente sem API rodando; auditor não rodou curl. Auditoria baseou-se em leitura estática + grep + trace do código de guards/extension Prisma. Se quiser prova end-to-end, rode (em ambiente de dev):

```bash
# Sem auth → 401
curl -i -X PATCH http://localhost:3000/parties/<id> \
  -H "Content-Type: application/json" \
  -d '{"isRecurringManualOverride":true}'

# OPERADOR (token com role OPERADOR) → 403
curl -i -X PATCH http://localhost:3000/parties/<id> \
  -H "Authorization: Bearer <OPERADOR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"isRecurringManualOverride":true}'

# ADMIN (mesmo payload) → 200 + party.isRecurringManualOverride===true
curl -i -X PATCH http://localhost:3000/parties/<id> \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"isRecurringManualOverride":true}'
```

---

## 10. CONCLUSÃO PARA O ORQUESTRADOR

**Sem BLOCKER. Pode integrar.** As 2 MEDIUM findings são melhorias de qualidade (consistência temporal + accountability), não vulnerabilidades. Corrija antes do próximo release se quiser; pode também abrir ticket para o próximo sprint. O LOW é decisão de produto — não bloqueia.
