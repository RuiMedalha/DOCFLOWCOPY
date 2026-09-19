# REVIEW FINDINGS — Toggle ADMIN de isRecurring (manual override)

**Missão:** Lx6BX4G1C2xb · **Pasta:** fix-recurring-toggle-admin/ · **Data:** 2026-09-03 · **Branch:** main · **HEAD:** 5d5aa3f
**Reviewer:** Opus 5
**Veredito:** 🟢 **Limpa. ZERO findings BLOCKER/HIGH/MEDIUM.** 2 LOW documentados abaixo como recomendação defensiva (não bloqueiam merge).

---

## Verificações por item (checklist A–G)

### A. RBAC dupla camada — ✅ LIMPO

| Camada | Local | Mecanismo |
|---|---|---|
| Decorator de rota | `apps/api/src/modules/parties/parties.controller.ts:200` | `@Roles(Role.ADMIN)` |
| Guard global | `apps/api/src/common/guards/rbac.guard.ts:32-58` (`APP_GUARD` em app.module.ts:140) | Lança `ForbiddenException` se `user.roles` não inclui ADMIN |
| Strategy | `apps/api/src/modules/auth/strategies/jwt.strategy.ts:44-75` | Recarrega `user.role` do DB a cada request (rola com tokens revogados) |
| Defesa em profundidade no service | `apps/api/src/modules/parties/parties.service.ts:267-272` | `ForbiddenException` quando non-ADMIN envia `isRecurring`/`isRecurringManualOverride` |

**Bypass impossível** sem comprometer a assinatura JWT. O `userRole` chega ao service via parâmetro (não lido de `req.user` via interceptor — abordagem mais explícita, mais auditável). Comparação `userRole !== 'ADMIN'` bate com `Role.ADMIN = 'ADMIN'` (rbac.guard.ts:17).

### B. Tenant isolation — ✅ LIMPO

`apps/api/src/modules/parties/parties.service.ts:251-261`: `prisma.party.findFirst({ where: { id, tenantId } })` antes de qualquer mutação. Ordem correta: 404 (não existe / cross-tenant) tem precedência sobre 403 (non-ADMIN) — não vaza informação sobre existência de party cross-tenant via mensagem de erro diferenciada.

Cobertura adicional: `PrismaService` extension (auto-scope, ver `parties.service.spec.ts:1027-1199`) injeta `tenantId` em TODAS as chamadas de modelo tenant-scoped — belt-and-suspenders.

Não foram criados testes de tenant isolation específicos para o PATCH, mas a infraestrutura subjacente já está coberta (C-01 cross-tenant tests em `parties.service.spec.ts`). Pragmático.

### C. Lógica do override (edge case) — ✅ LIMPO

`apps/api/src/modules/extraction/supplier-resolver.ts:265-292`:
- Se `isRecurringManualOverride === true` → retorna `existing.isRecurring` sem update (linha 277-279).
- Se override === false (ou não existe) → cai no caminho normal: `shouldRecur = docCount + pendingDocuments >= 3` → re-flipa se atingir threshold (linha 286-290).

Cenário do briefing (ADMIN desliga override + count já ≥ 3): **re-flipa corretamente** na próxima extração do supplier. ✓

Cenário oposto (ADMIN desliga override + `isRecurring` ficou `true` mesmo com count < 3): a flag **permanece true** sem re-justificação. Ver observação LOW#1 abaixo.

### D. Frontend security — ✅ LIMPO

`apps/web/app/(dashboard)/parties/[id]/page.tsx:17-18`: `useUser()` busca user do JWT (cookie httpOnly) → `user.role` não pode ser manipulado client-side sem novo login. Submit filtra (party-form.tsx:54-55): `isRecurring: isAdmin ? form.isRecurring : undefined`.

`apps/web/app/(dashboard)/parties/new/page.tsx:15`: `<PartyForm />` chamado sem `isAdmin` → prop fica `undefined` → bloco ADMIN não renderiza → submit não envia os campos. **Comportamento correto** mesmo sem o prop (gates pelo fallback falsy).

### E. Migration non-blocking — ✅ LIMPO

`apps/api/prisma/migrations/20260903000000_add_recurring_override/migration.sql`:
```sql
ALTER TABLE "parties" ADD COLUMN "isRecurringManualOverride" BOOLEAN NOT NULL DEFAULT false;
```

`DEFAULT false` + `NOT NULL` = `ALTER TABLE` instantâneo no Postgres 11+ (sem rewrite). Dados existentes preservados: todas as rows passam a `false`, comportamento idêntico ao status quo. ✓

### F. Compilação — ✅ LIMPO

**apps/api** (`npx tsc --noEmit`):
- 13 erros pré-existentes em `documents.service.spec.ts`, `extraction.service.spec.ts`, `integrations.e2e.spec.ts`, `payments.service.spec.ts` — **arquivos NÃO tocados pelo diff** (briefing previa: "apps/api pode ter os 13 .spec.ts pré-existentes, ZERO novos").
- 0 erros em arquivos modificados pelo diff (`parties-update.spec.ts`, `supplier-resolver.spec.ts`, `parties.service.ts`, `party.dto.ts`, `parties.controller.ts`, `supplier-resolver.ts`).

**apps/web** (`npx tsc --noEmit`): **100% clean**, 0 erros, 0 warnings.

### G. Testes — ✅ LIMPO (7 testes, cobertura suficiente)

**`apps/api/src/modules/parties/__tests__/parties-update.spec.ts`** (4 testes):
1. non-ADMIN rejeitado tentando mudar `isRecurring` → `ForbiddenException`
2. non-ADMIN rejeitado tentando mudar `isRecurringManualOverride` → `ForbiddenException`
3. ADMIN consegue mudar ambos os campos
4. ADMIN consegue mudar só `isRecurringManualOverride`

**`apps/api/src/modules/extraction/__tests__/supplier-resolver.spec.ts`** (3 testes):
1. override=true + locked=false + count=10 (alto) → retorna false (locked), NÃO chama update
2. override=false + count=3 (threshold exato) → flipa para true, chama update
3. override=true + locked=true + count=0 (baixo) → retorna true (locked), NÃO downgrades ← **edge case coberto**

Bônus: o teste #3 confirma exatamente o edge case invertido do briefing — "lock trava o valor SEMPRE, mesmo se count não sustenta o true". ✓

---

## Findings LOW (não-bloqueiam, recomendações defensivas)

### LOW#1 — `supplier-resolver.ts:271-292`: re-flip assimétrico

**Arquivo:** `apps/api/src/modules/extraction/supplier-resolver.ts:271-292`
**Severidade:** LOW
**Descrição:** Quando ADMIN desliga `isRecurringManualOverride` mas o party já tem `isRecurring=true` (lockado em true) e `docCount < 3`, o auto-flip **não desliga** `isRecurring`. A flag fica órfã "true" sem re-justificação.
**Cenário de falha:** ADMIN liga override + set isRecurring=true, ADMIN desliga override, count atual < 3. Resultado: isRecurring=true sem base derivada. Inconsistente com o caminho natural (auto-flip só liga quando count ≥ 3).
**Por que é LOW:** (1) Comportamento conservador — não perde classificação; (2) ADMIN pode re-zerar manualmente via PATCH; (3) Caso raro na prática.
**Fix sugerido:** Adicionar lógica em `refreshRecurringFlag`: se override foi desligado E `isRecurring=true` E `docCount + pending < 3`, fazer `update({ isRecurring: false })`. Ou documentar explicitamente que a flag é "freezable" mas não "self-cleaning".

### LOW#2 — `apps/web/app/(dashboard)/parties/new/page.tsx:15`: `PartyForm` sem `isAdmin` explícito

**Arquivo:** `apps/web/app/(dashboard)/parties/new/page.tsx:15`
**Severidade:** LOW
**Descrição:** `<PartyForm />` é chamado sem o prop `isAdmin`. Hoje funciona (undefined → falsy → submit não envia os campos ADMIN-only). Frágil se alguém futuramente mudar o default ou esquecer de tratar.
**Por que é LOW:** Comportamento atual é seguro. Apenas issue de manutenção.
**Fix sugerido (uma das duas):**
- (a) Passar `isAdmin={user?.role === 'ADMIN'}` explicitamente em `new/page.tsx` (consistência com `[id]/page.tsx:90`).
- (b) Mudar assinatura para `isAdmin = false` default em `party-form.tsx:9`: `isAdmin?: boolean = false` — mais defensivo.

---

## Resumo

| Categoria | Contagem |
|---|---|
| BLOCKER | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW (defensivas, não-bloqueiam merge) | 2 |

**Recomendação:** PROCEED COM MERGE. Os 2 LOW são sugestões defensivas para harden futuro — não impactam a entrega do toggle ADMIN.
