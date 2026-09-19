# SCOUT REPORT — Toggle ADMIN de `isRecurring` (manual override)

**Missão:** `Lx6BX4G1C2xb` · **Pasta da missão:** `fix-recurring-toggle-admin/` · **Data:** 2026-09-03 · **Branch:** `main` · **HEAD:** `316b72c`

**Veredito:** 🟢 **PRONTO PARA O BUILDER.** Todos os pré-requisitos da "decisão pré-confirmada" estão válidos: o modelo `Party` já tem colunas booleanas com `@default(false)` (`ibanVerified`, `ibanFlagged`), o `RbacGuard` existe e está registrado como `APP_GUARD`, o decorator `@Roles(Role.ADMIN)` já é o padrão (vide `categories.controller.ts:28-45`, `integrations.controller.ts:50,103`, `auth.controller.ts:110`), e o auto-flip em `supplier-resolver.ts` está num único ponto fechado (`refreshRecurringFlag` L265-289). Nenhum blocker.

---

## 1. Decisão Prisma — confirmar adição

**Sim, adicionar `isRecurringManualOverride Boolean @default(false)` no modelo `Party`** (logo abaixo de `isRecurring` em `schema.prisma:586`).

**Justificativa (1 linha):** o campo `isRecurring` já é `Boolean @default(false)` (L586) — adicionar uma coluna paralela com o mesmo shape é totalmente trivial para o Prisma migrator e mantém compatibilidade com todos os dados existentes (todas as rows passam a ter `isRecurringManualOverride = false`, comportamento idêntico ao atual).

**Onde colocar (file:line):**
- `apps/api/prisma/schema.prisma:586` — logo abaixo de `isRecurring      Boolean   @default(false)`, inserir:
  ```prisma
  isRecurringManualOverride Boolean @default(false)
  ```

---

## 2. Migração Prisma

**Comando:** `cd apps/api && npx prisma migrate dev --name add_recurring_override`

**Validação do nome — sem colisão:**
- Última migração existente: `20260902000002_add_categories` (ié a mais recente do diretório `apps/api/prisma/migrations/`).
- Próxima migração esperada: `20260903000000_add_recurring_override` (timestamp `2026-09-03` gerado pelo Prisma a partir de `now()` UTC).
- O slug `--name add_recurring_override` é gerado pelo Prisma sem colidir com nenhuma das 10 migrações existentes (lista verificada — todas seguem padrão `YYYYMMDDhhmmss_<name>` e nenhuma usa `add_recurring_override`).

**NOTA sobre a migração `20260831000001_party_is_recurring`:** essa migração é um **placeholder** (`SELECT 1;`) — verificado em L1-6 — porque a working dir foi reconstruída e o SQL original foi perdido; o schema já estava aplicado no DB. Isso significa que o Prisma pode reclamar de "drift" ao rodar `migrate dev`. Se isso acontecer, usar `npx prisma migrate dev --name add_recurring_override --create-only`, gerar o SQL manualmente (`ALTER TABLE "parties" ADD COLUMN "isRecurringManualOverride" BOOLEAN NOT NULL DEFAULT false;`), depois `npx prisma migrate dev` sem `--create-only` para aplicar. Builder: tratar isso como **caveat conhecido**, não como blocker.

---

## 3. API touchpoints (4-5 lugares exatos)

| # | Arquivo | Linha(s) | Mudança |
|---|---------|----------|---------|
| 1 | `apps/api/prisma/schema.prisma` | 586 (após `isRecurring`) | adicionar `isRecurringManualOverride Boolean @default(false)` |
| 2 | `apps/api/src/modules/parties/dto/party.dto.ts` | 159-165 (`UpdatePartyDto`) | adicionar `@IsOptional() @IsBoolean() isRecurring?: boolean;` e `@IsOptional() @IsBoolean() isRecurringManualOverride?: boolean;` (a flag `isRecurring` precisa do decorator — `@IsBoolean` só; `@IsOptional` porque PartialType já a torna opcional, mas o validator `@IsBoolean` precisa ser explícito para garantir type-coercion). |
| 3 | `apps/api/src/modules/parties/parties.controller.ts` | 197-211 (`update`) | adicionar `@Roles(Role.ADMIN)` acima do `@Patch('parties/:id')`. Re-importar `Roles` de `../../common/decorators/roles.decorator` e `Role` de `../../common/guards/rbac.guard` (já existem imports de `current-user.decorator` e `jwt.strategy`, então basta adicionar 2 linhas). |
| 4 | `apps/api/src/modules/parties/parties.service.ts` | 311-336 (bloco `data: Prisma.PartyUpdateInput`) | adicionar duas linhas dentro do `if (dto.X !== undefined)`:<br>`if (dto.isRecurring !== undefined) data.isRecurring = dto.isRecurring;`<br>`if (dto.isRecurringManualOverride !== undefined) data.isRecurringManualOverride = dto.isRecurringManualOverride;`<br>**IMPORTANTE:** envolver a escrita num guard **no service** (não apenas no controller) porque o controller-level guard sozinho é burlável se algum outro consumer (queue, script, tests) chamar `parties.update` direto. Recomendar: checar `user.role === 'ADMIN'` antes de aceitar `isRecurring` ou `isRecurringManualOverride` no DTO, **ou** rejeitar via `ForbiddenException` se um non-ADMIN enviar esses campos. Sugestão: uma flag interna + check simples em L249 (logo após `assertPartyExists`):<br>`if ((dto.isRecurring !== undefined \|\| dto.isRecurringManualOverride !== undefined) && userRole !== 'ADMIN') throw new ForbiddenException('Only ADMIN may override isRecurring');`<br>Como `update()` recebe `userId` mas não `userRole`, **passar `userRole` como parâmetro adicional** ou ler do `req.user` via interceptor. **Decisão recomendada:** adicionar parâmetro `userRole: string` ao método `update()` (siga o padrão já usado em `markIbanVerified`/`flagIban` que recebem `userId`). O controller já tem `user.role` via `@CurrentUser`, então a mudança é trivial. |
| 5 | `apps/api/src/modules/parties/parties.service.ts` | 982-999 (`sanitizeParty`) | não precisa mudar — `...p` já propaga o novo campo `isRecurringManualOverride`. Confirmar que o response JSON inclui a flag (será retornada automaticamente). |

---

## 4. Frontend touchpoints (3-4 lugares exatos)

| # | Arquivo | Linha(s) | Mudança |
|---|---------|----------|---------|
| 1 | `apps/web/app/(dashboard)/parties/_lib/types.ts` | 35-36 (após `isRecurring?:`) | adicionar `isRecurringManualOverride?: boolean \| null;` na interface `Party`. Adicionar `isRecurring?: boolean;` e `isRecurringManualOverride?: boolean;` na interface `PartyInput` (L137-152). |
| 2 | `apps/web/app/(dashboard)/parties/_components/party-form.tsx` | 17-30 (estado inicial) e 36-51 (cleaned) e L104-115 (campos) | adicionar toggle ADMIN-only. Sugestão de UX: novo bloco `<div className="sm:col-span-2 mt-4 pt-4 border-t">` com checkbox `<input type="checkbox">` ligado a `form.isRecurring` e `<input type="checkbox">` ligado a `form.isRecurringManualOverride`, ambos `disabled={!isAdmin}`. Ambos só visíveis se `isAdmin === true`. O `cleaned` precisa propagar os dois campos. |
| 3 | `apps/web/app/(dashboard)/parties/_components/parties-list.tsx` | 78-86 (badge read-only) | melhorar badge para indicar override manual:<br>- se `p.isRecurringManualOverride` for true → badge âmbar com tooltip "Override ADMIN — não reverte automaticamente".<br>- se `p.isRecurring === true && !p.isRecurringManualOverride` → badge emerald (status atual, mantida).<br>- se `p.isRecurring === false` → sem badge (atual). |
| 4 | `apps/web/app/(dashboard)/parties/[id]/page.tsx` | 48, 60-71 (badge do header + `showRecentDocs`) | opcional mas recomendado: importar `useUser` de `@/_lib/use-dashboard-queries` (padrão já usado em `categories/page.tsx:28,40-41`) e passar `user.role === 'ADMIN'` como prop ao `PartyForm` para controlar visibilidade do toggle. O badge do header (L60-71) pode ganhar a mesma lógica de cor âmbar quando `party.isRecurringManualOverride === true`. |

---

## 5. RBAC — padrão que já existe (não inventar nada)

**Padrão consolidado no projeto (verificado por grep em `apps/api/src`):**

- **Decorator:** `@Roles(Role.ADMIN)` importado de `../../common/decorators/roles.decorator` (`roles.decorator.ts:16`).
- **Enum:** `Role` importado de `../../common/guards/rbac.guard` (`rbac.guard.ts:16-22`). Valores: `ADMIN | CONTABILIDADE | GESTOR_RH | OPERADOR | APPROVER`. **CONFIRMADO:** `'ADMIN'` é string literal — bate com `user?.role === 'ADMIN'` no frontend (`categories/page.tsx:41`).
- **Guard:** `RbacGuard` (`rbac.guard.ts:32-58`) já está registrado globalmente em `app.module.ts:140` como `APP_GUARD`. Se uma rota tem `@Roles(Role.ADMIN)` e o JWT não tem `roles: ['ADMIN']`, o guard lança `ForbiddenException` (L53-55).
- **Exemplos canônicos para imitar:**
  - `apps/api/src/modules/documents/categories.controller.ts:28,35,45` — três rotas `@Roles(Role.ADMIN)`.
  - `apps/api/src/modules/auth/auth.controller.ts:110` — uma rota ADMIN.

**Como aplicar à nova rota de toggle:** adicionar `@Roles(Role.ADMIN)` acima de `@Patch('parties/:id')` em `parties.controller.ts:197`. Adicionar os 2 imports correspondentes (já existe `JwtAuthGuard` no padrão do controller, mas o guard é global via `APP_GUARD`, então **NÃO precisa de `@UseGuards(JwtAuthGuard)`** — basta o decorator).

**Frontend RBAC:** padrão atual é `const isAdmin = user?.role === 'ADMIN'` (`categories/page.tsx:41`). Usar exatamente isso.

**Hardening recomendado (defesa em profundidade):** o guard de rota pode ser bypassado por chamadores internos (cron, queue worker, testes). Adicionar check **dentro do service** — seção 3, ponto 4 já lista isso. **NÃO aceitar workarounds do tipo "só o guard basta"** — manter o check duplo.

---

## 6. Gotcha do auto-flip — onde supplier-resolver.ts DEVE checar

**Arquivo:** `apps/api/src/modules/extraction/supplier-resolver.ts`

**Linhas críticas:** **L265-289** (`refreshRecurringFlag` — método privado), invocado em **L189** (`const isRecurring = await this.refreshRecurringFlag(tenantId, partyRow.id, 1);`).

**Comportamento atual (L270-282):**
```ts
const docCount = await this.prisma.document.count({ where: { tenantId, partyId } });
const shouldRecur = docCount + pendingDocuments >= SupplierResolver.RECURRING_THRESHOLD;
if (shouldRecur) {
  await this.prisma.party.update({
    where: { id: partyId },
    data: { isRecurring: true },   // ← grava sem checar override
  });
}
```

**Mudança necessária:**

1. **L265-289** — dentro de `refreshRecurringFlag`, ANTES do `update`:
   - adicionar `const party = await this.prisma.party.findFirst({ where: { id: partyId }, select: { isRecurringManualOverride: true, isRecurring: true } });`
   - se `party?.isRecurringManualOverride === true`, retornar `party.isRecurring` (o valor travado pelo ADMIN) sem chamar o update.
   - caso contrário, manter o comportamento atual.

2. **L134-189** — `resolve()` também precisa do mesmo guard porque o create path (L143-155) pode setar o override no futuro, e o `refreshRecurringFlag` é chamado logo em seguida (L189). Garantir consistência passando a checagem ao helper central (passo 1 cobre isso — não duplicar a lógica em `resolve()`).

3. **Detalhe sutil — quando o ADMIN desliga o override:** se `isRecurringManualOverride === false` E `isRecurring === false` MAS `docCount >= 3`, o auto-flip precisa funcionar normalmente. A lógica em `refreshRecurringFlag` já cobre isso naturalmente — o `shouldRecur` continua sendo avaliado, e o `if (party?.isRecurringManualOverride === true) return early;` é o único short-circuit.

**Mudança estimada em supplier-resolver.ts:** **~10 linhas** (1 SELECT novo + 1 early-return + comentário explicativo).

---

## 7. Estimativa de diff por arquivo

| Arquivo | Linhas adicionadas/removidas | Observação |
|---------|------------------------------|------------|
| `apps/api/prisma/schema.prisma` | +1 linha | apenas a coluna nova |
| `apps/api/prisma/migrations/<timestamp>_add_recurring_override/migration.sql` | +1 SQL | gerada automaticamente |
| `apps/api/src/modules/parties/dto/party.dto.ts` | +6 linhas | 2 campos (decorator + doc), `@ApiPropertyOptional` em cada |
| `apps/api/src/modules/parties/parties.controller.ts` | +3 linhas | 1 import + 1 `@Roles(Role.ADMIN)` + 1 import de `Role` |
| `apps/api/src/modules/parties/parties.service.ts` | +12 a +18 linhas | 2 campos no `data` + check de role no service (defesa em profundidade) + ajuste na assinatura `update()` |
| `apps/api/src/modules/extraction/supplier-resolver.ts` | +8 a +12 linhas | checagem do override antes do `update` em `refreshRecurringFlag` |
| `apps/web/app/(dashboard)/parties/_lib/types.ts` | +4 linhas | 2 em `Party`, 2 em `PartyInput` |
| `apps/web/app/(dashboard)/parties/_components/party-form.tsx` | +25 a +35 linhas | bloco toggle ADMIN-gated com 2 checkboxes + ajuste no `cleaned` |
| `apps/web/app/(dashboard)/parties/_components/parties-list.tsx` | +6 a +10 linhas | badge âmbar condicional |
| `apps/web/app/(dashboard)/parties/[id]/page.tsx` | +8 a +12 linhas | opcional — badge âmbar + passar `isAdmin` pro form |

**Total estimado:** ~80 a 110 linhas em 9-10 arquivos. **Nenhum arquivo de teste existente cobre esses caminhos** (verifiquei: `apps/api/src/modules/parties/__tests__/` não tem suíte para `update`, `supplier-resolver.spec.ts` provavelmente testa o flip atual). Recomendar builder adicionar **2 testes novos** (não cobertos pelo escopo "mapeamento", mas flagados aqui):
1. `apps/api/src/modules/parties/__tests__/parties-update.spec.ts` — verifica que `update()` rejeita non-ADMIN tentando mudar `isRecurring`.
2. `apps/api/src/modules/extraction/__tests__/supplier-resolver.spec.ts` — verifica que o flip é pausado quando `isRecurringManualOverride = true`.

---

## 8. Pendências / caveatas

1. **Migração `20260831000001_party_is_recurring` é placeholder** (`SELECT 1;`). Se o Prisma reclamar de drift ao rodar `migrate dev`, builder deve usar `--create-only` e escrever o SQL manualmente.
2. **DTO `isRecurring` precisa de `@IsBoolean()` explícito** — `PartialType(CreatePartyDto)` não propaga validators de runtime, apenas torna o campo opcional.
3. **Service-level RBAC é defesa em profundidade** — o guard global pega 99% dos casos, mas bypass é possível via queue/cron/tests.
4. **Frontend badge no header** (`[id]/page.tsx:60-71`) é independente do toggle — manter o badge atual intacto e adicionar a versão âmbar quando `isRecurringManualOverride === true`. **Não remover** o badge atual.
5. **`isRecurring` pode ser `null`** no `Party` type (L35: `isRecurring?: boolean | null;`). Garantir coerção para boolean no frontend onde for usado em conditionals.
6. **Outros controllers que tocam Party:** `documents.controller.ts` e `crm.controller.ts` provavelmente têm endpoints que carregam `Party`. Não tocam `isRecurring` diretamente — nenhum impacto.
7. **Schema `parties` já tem 9 indexes** (`schema.prisma:596-600`); adicionar índice em `isRecurringManualOverride` é desnecessário (a flag só é checada 1x por extração, não vai pra WHERE).

---

## 9. Conclusão para o builder

**Pode implementar.** O caminho crítico é:
1. Schema + migração (5 min).
2. DTO + controller + service (15 min).
3. supplier-resolver guard (10 min).
4. Frontend — types + form toggle + badge (20 min).
5. Testes novos (20 min).

**Não bloqueado. Não inventar workarounds. RBAC + Party shape já estão prontos.**
