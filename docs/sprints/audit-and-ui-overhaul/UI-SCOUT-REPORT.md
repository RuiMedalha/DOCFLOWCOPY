# UI Scout Report — `/documents/[id]`

> Scout persona: frontend-developer. Opus 5. Skill carregada: `frontend-design` (DFII disponível na próxima fase).
> Working dir: `C:\Projetos\docflow-mvp\apps\web\app\(dashboard)\documents\[id]`
> Foco: mapear a página atual para o designer saber o que atacar no UI overhaul.
> **Nada foi editado.** Apenas leitura.

---

## 1. TL;DR — O que a página é hoje

A página de detalhe do documento é uma **dashboard de revisão fiscal de duas colunas** (12-col grid, 5/7 split em `xl:`). É funcionalmente completa: viewer do PDF, validação QR-AT, anti-fraude IBAN, edição de campos OCR com confiança, edição de linhas (admin/operador), contabilização e stub de envio para TOConline. Visualmente, é **um formulário competente de SaaS corporativo escuro** — Linear-grade polish, mas sem identidade memorável. Há 8 zonas distintas empilhadas com a mesma estrutura "card + legenda uppercase", o que gera monotonia.

---

## 2. Arquitetura da página (zonas)

```
┌──────────────────────────────────────────────────────────────────────┐
│  PageHeader  (page.tsx)                                              │
│  ─ Title (docNumber / fileName)   ─ Voltar btn   ─ Status badge      │
├──────────────────────────────────────────────────────────────────────┤
│ grid grid-cols-1 xl:grid-cols-12 gap-6 animate-in                     │
│ ┌─── LEFT (col-span-5, sticky top-4) ──┐ ┌─── RIGHT (col-span-7) ──┐ │
│ │ [1] DocumentViewer        (card)     │ │ [A] FieldPanel           │ │
│ │     - toolbar com fileName           │ │     header + actions     │ │
│ │     - iframe PDF / <img> / fallback  │ │ [B] Identidade           │ │
│ │     - min-h-[420px]                  │ │ [C] Datas + IBAN         │ │
│ │ ─────────────────────────────────── │ │ [D] Categoria            │ │
│ │ [2] "Autenticação AT"  (card)        │ │ [E] Montantes + Δ total  │ │
│ │     <QrBadge>                        │ │ [F] Linhas (tabela)      │ │
│ │ ─────────────────────────────────── │ │ [G] Contabilização       │ │
│ │ [3] "Verificação IBAN" (card)        │ │ [H] Enviar TOConline     │ │
│ │     <FraudWarning>                   │ │ [I] Aviso por aprovar    │ │
│ └─────────────────────────────────────┘ └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Zonas numeradas

| # | Zona | Componente | Onde | Função visual |
|---|------|------------|------|---------------|
| 1 | **DocumentViewer** | `document-viewer.tsx` | LEFT 1 | Toolbar com ícone + nome + badges + download/expand. Iframe `<object>` para PDF, `<img>` para imagem, fallback para outros. Skeleton no loading, card de erro. |
| 2 | **QR-AT** | `qr-badge.tsx` | LEFT 2 | Botão expansível. Estado collapsed = chip com ícone + "QR-AT detectável" + NIF + total. Expandido = dl em 2-col com todos os pares `A:…` `B:…` … (FIELD_LABELS). Highlights com `rgba(56,189,248,.12)` para campos que matcham o QR. `<details>` para payload bruto. |
| 3 | **IBAN fraud check** | `fraud-warning.tsx` | LEFT 3 | Banner: retorna `null` se match OK e silencioso, ou 3 variantes (amber "novo IBAN", green "confere", rose "não confere"). role=alert no mismatch. |
| A | **FieldPanel header** | (in field-panel) | RIGHT 1 | "Campos extraídos" + badge da categoria (colorida por categoria) + badge "Aprovado" + 3 botões (Re-extrair, Aprovar, Guardar). Guardar é `btn-primary`. |
| B | **Identidade** | fieldset card | RIGHT 2 | Fornecedor + NIF + Nº doc + ATCUD. |
| C | **Datas + IBAN** | fieldset card | RIGHT 3 | Data doc / Vencimento + IBAN (com "today" badge à direita). |
| D | **Categoria** | fieldset card | RIGHT 4 | `<select>` único. |
| E | **Montantes** | fieldset card | RIGHT 5 | Base / IVA / Total em `grid-cols-3`. Footer de reconciliação com soma linhas vs base+IVA vs Δ total — `Δ total` muda de cor (warning se >0.05). |
| F | **Linhas** | section card | RIGHT 6 | Tabela `<table>` com colunas condicionais (Cód. só se há códigos, Desc. só se há descontos). Totais em `<tfoot>`. ADMIN/OPERADOR veem inputs por célula com onBlur → PATCH. |
| G | **Contabilização** | fieldset card | RIGHT 7 | 2 selects (débito/crédito) usando `accounts[]`. |
| H | **TOConline** | card + botão | RIGHT 8 | Barra horizontal com label + botão "Enviar". Desabilitado se não aprovado. |
| I | **Aviso por aprovar** | parágrafo | RIGHT 9 | Só renderiza se `!approved`. Texto amber com ShieldAlert. |

---

## 3. Componentes visuais atuais — o que cada um faz

### 3.1 `page.tsx` (orquestrador)

- **`useDocumentBundle(id)`** — TanStack Query, 4 fetches paralelos (doc, items, ibanHistory, accounts), com mock fallback em 404 / offline.
- **Estado local otimista** `draft` — edits do usuário, flush em "Guardar". Filtra payload contra `allowedKeys` (whitelist do `class-validator` no backend) pra evitar 400.
- **`onSave`**, **`onReExtract`**, **`onApprove`**, **`onAssignDebit/Credit`**, **`onSendToToc`**, **`onAddLineItem`**, **`onUpdateLineItem`**, **`onDeleteLineItem`** — todos com toast feedback (`toastBus.success/error`).
- **Role gating**: `canEditLines` (ADMIN/OPERADOR) reflete regra do backend.
- **Estados de loading**: spinner centralizado (`Loader2` + texto) se `bundle.isLoading`; error card com botão "Voltar à lista" se `!bundle.data`.
- **Header**: `<PageHeader>` com title = `doc.docNumber ?? doc.fileName ?? "Documento <id8>"`. Subtitle = supplier + NIF. Actions = Voltar btn + status badge. **Status badge** mapeado por `statusTone` (NOVO=sky, EM_REVISAO=amber, APROVADO=emerald, REJEITADO=rose, CONCILIADO=violet, PAGO=neutral).

### 3.2 `field-panel.tsx`

- **`confBadge(c)`** — chip com dot + percent label. Cores: green ≥0.85, amber ≥0.6, red <0.6. Background é `rgba(...)` calculado manualmente em vez de classe `.badge-*` (inconsistência menor).
- **`Field` primitive** — label + slot direito (pode conter `confBadge` + "today" badge para IBAN) + children.
- **`MoneyInput`** — `<input type="number">` com suffix `{ccy}` à direita em `var(--text-subtle)`.
- **`NumberCell`** — input controlado localmente pra evitar PATCHs espúrios; commit onBlur ou Enter; revert onEscape.
- **Reconciliation footer** (E) — usa `--hover` background, 3 colunas com `tabular-nums`. Δ total muda cor.
- **Linhas table** — colunas condicionais por feature flag (Cód./Desc.). `<tfoot>` com soma. Cell editing via `NumberCell` ou `<input className="input input-xs">` pra descrição.
- **TOConline card** (H) — `card p-3.5` com label + botão `btn-secondary`. Tooltip explica por que está desabilitado.

### 3.3 `document-viewer.tsx`

- **3 modos**: `application/pdf` (iframe), `image/*` (`<img>`), outros (fallback com download CTA).
- **Auth-aware fetch**: `authedFetch(src)` com `AbortController`. Blob URL revocado no unmount.
- **Toolbar**: ícone colorido (`--accent`), filename, badge "N campos destacados" se QR-AT match, btn-ghost "external link", btn-ghost "download".
- **States**: idle (sem src) → loading (spinner) → ready (render) → error (card).
- **Body background**: `rgba(0,0,0,0.18)` — escuro neutro sobre `--bg-card`. Contraste OK mas sem textura.

### 3.4 `qr-badge.tsx`

- **Empty state**: chip `badge-neutral` "Sem QR-AT".
- **Populated**: botão toggle. Chip ícone emerald (válido) ou amber (com erros). Linha secundária com NIF + uniqueDocId + total.
- **Expanded**: dl em 2-col com todos os campos (A-H, I1-O, P-R). Highlights com `rgba(56,189,248,.12)` quando match. Validation errors/warnings listadas no topo.
- **Payload bruto**: `<details><summary>` revelando `<pre>` formatado. PT-friendly.
- **Parser vem do `@docflow/shared`** — garante que UI e backend usam o mesmo decode (bom).

### 3.5 `fraud-warning.tsx`

- 3 estados: sem IBAN (null), IBAN novo (amber advisory), IBAN match (green silencioso), IBAN mismatch (rose alert).
- **Mismatch**: lista histórico conhecido como "PT50... (8× desde 2025-11-04) · PT50... (3× desde 2024-04-18)". Warning final: "Possível fraude ou troca de IBAN — confirme com o fornecedor antes de pagar."
- **`role="alert"`** só no mismatch. Bom para screen reader.

### 3.6 `use-document-detail.ts`

- **`toDateInputValue`** — converte ISO timestamp → `YYYY-MM-DD` pro `<input type="date">`.
- **`expandConfidence`** — se backend manda um score só, replica em todos os campos (workaround para granularidade).
- **`extractQrFields`** — parser client-side dos códigos A-H/I1-R.
- **`buildMockBundle`** — fatura EDP mock com IBAN history, accounts, items reais. Cai aqui em 404/offline. Bom pra demo, ruim se esquecer no prod.

---

## 4. Stack de styling

### 4.1 Tailwind + tokens CSS (mixed)

- **Tailwind** usado para layout (`grid grid-cols-12 gap-6`), spacing (`p-4 space-y-3`), sizing (`min-h-[420px]`, `h-7`), flex utilities.
- **Tokens CSS custom** (`globals.css`) para TODAS as cores, sombras, radii, motion. Tailwind mapeia `colors.bg`, `colors.accent`, etc. para `var(--*)`.
- **Inline `style={{ background: 'var(--...)' }}`** muito usado no JSX — não é mau cheiro, é idiomático no projeto.

### 4.2 Tema: dual light/dark

- **Dark é o default** (`color-scheme: dark`). Background `--bg: #070b14` (slate-950 quase preto).
- **Light** ativa por `[data-theme='light']`. Mesmas variáveis com hex mais claros.
- Brand gradient: `linear-gradient(135deg, #38bdf8 → #818cf8 → #a78bfa)` — sky → indigo → violet. Aplicado em `.btn-primary` e `.brand-mark`.

### 4.3 Cores principais (hex do `globals.css`)

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#070b14` | `#f8fafc` |
| `--bg-card` | `rgba(15, 23, 42, 0.72)` | `rgba(255, 255, 255, 0.85)` |
| `--text` | `#f1f5f9` | `#0f172a` |
| `--text-muted` | `#94a3b8` | `#475569` |
| `--text-subtle` | `#64748b` | `#64748b` |
| `--accent` | `#38bdf8` (sky-400) | `#0284c7` (sky-600) |
| `--success` | `#34d399` | `#059669` |
| `--warning` | `#fbbf24` | `#d97706` |
| `--danger` | `#f87171` | `#dc2626` |

### 4.4 Fontes

- **Sans**: `var(--font-inter), system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` — **Inter**. Carregada via `next/font` no `layout.tsx` provavelmente.
- **Mono**: `'JetBrains Mono', ui-monospace, SF Mono, monospace` — JetBrains Mono. Usada em NIFs, IBAN, ATCUD, código, números.
- **Problema**: Inter é a fonte mais "AI-default" do mercado. Cai exatamente na regra do `frontend-design` skill (anti-pattern explícito).

### 4.5 Animações

- `@keyframes fadeInUp`, `fadeInScale`, `slideInRight`, `shimmer`, `pulseGlow`, `orbDrift`.
- Classe `.animate-in` aplicada no root do grid (one-shot no mount).
- Spinners `animate-spin` em botões durante mutations.
- **`prefers-reduced-motion`** respeitado globalmente (boas práticas a11y).

### 4.6 Componentes-chave (`@layer components`)

- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger` (todos com `--radius`).
- `.input` (com focus ring accent), `.input-sm`, `.input-lg`.
- `.card`, `.card-solid`, `.glass`, `.glass-card` (com `backdrop-filter: blur`).
- `.badge` + 6 variantes tone (`-sky`, `-emerald`, `-amber`, `-violet`, `-rose`, `-neutral`).
- `.nav-item-active` usa `brand-gradient-soft` como bg.

---

## 5. Gaps de UX (percepção pré-DFII)

### 5.1 Hierarquia visual

- **Nenhum elemento "domina"**. Tudo é o mesmo card com a mesma legenda uppercase. O olho vagueia sem landing point.
- O botão **"Guardar"** é o único `btn-primary` no canto direito do FieldPanel header — esse é o único CTA com peso real, mas é de baixa confiança (Save ≠ Confirm ≠ Approve). **Approve** deveria ser mais hero.
- Status badge no PageHeader é discreto demais (cor + label). Não há ícone grande que diga "isto está em revisão e tem de ser aprovado hoje".
- O `<DocumentViewer>` (PDF iframe) é a zona mais pesada visualmente, mas ocupa 5/12 — perde para o formulário 7/12 que é denso.

### 5.2 Tipografia

- **Inter + Inter** (não há display font separada). Títulos são apenas Inter bold. Nenhuma expressão tipográfica.
- Escala é conservadora: `text-2xl/3xl` no page-title, `text-lg` no FieldPanel header, `text-sm` em tudo. Quase nenhuma variação de peso (`font-semibold` no máximo).
- `tabular-nums` corretamente aplicado em valores monetários. Bom.

### 5.3 Paleta

- **3-accent brand gradient** (sky → indigo → violet) é o único "show off" — mas só aparece em `.btn-primary` e `.brand-mark` (sidebar logo). Field-panel usa só `--accent` (sky).
- **Hex que aparecem visualmente na página**: `#070b14` (bg), `#f1f5f9` (text), `#38bdf8` (accent), `#94a3b8` (muted), `#64748b` (subtle), `#34d399`/`#fbbf24`/`#f87171` (status dots), `#818cf8`/`#a78bfa` (raro).
- Status colors competem entre si: rose para REJEITADO vs rose para IBAN mismatch vs rose para delete — **3 usos de "perigo" no mesmo ecrã**.

### 5.4 Espaço

- **Densidade alta**. Cards com `p-4 space-y-3` empilhados em gap-6. Em viewport 1440 o usuário vê ~6 cards sem scroll.
- `min-h-[420px]` no viewer é arbitrário — pode ser desperdício ou aperto dependendo do PDF.
- Inputs `min-height: 2.75rem` (44px) — OK touch target mas visualmente "gordos".
- Pouco respiro entre seções. As **legends** (`IDENTIDADE DO DOCUMENTO`) são o único separador semântico.

### 5.5 Memorabilidade

- **Zero anchor memorável**. Logotipo OK, gradiente bonito, mas se remover a logo ninguém reconhece isto como DocFlow.
- Componentes são todos "shadcn-grade SaaS padrão" — competente mas genérico.
- A página funciona; não surpreende.

---

## 6. Pontos de fricção (UX debt)

### 6.1 Ações críticas escondidas / sem confirmação

| Ação | Como aparece | Falta |
|---|---|---|
| **Aprovar** | btn-secondary pequeno no header | Confirmação? Lock visual depois de aprovar? |
| **Eliminar linha** | X de 24px no canto da row | Sem confirmação (DELETE direto). **Risco.** |
| **Re-extrair** | btn-secondary pequeno | Sem aviso "isso vai sobrescrever edits". |
| **Guardar** | btn-primary grande | Sem indicação de dirty state. User pode editar e ir embora sem salvar. |
| **Atribuir conta débito/crédito** | `<select>` com PATCH onChange | Sem undo / diff visível. |
| **Enviar TOConline** | btn-secondary | Sem progresso (% / fila). É só um "A enviar…" durante o request. |

### 6.2 Loading & estados vazios

- Loading inicial: spinner + texto "A carregar documento…". OK mas é só 1 estado — falta skeleton estruturado para a página inteira (shimmer placeholders nos cards).
- Empty IBAN history: "É a primeira vez que vemos o IBAN..." — bom copy, mas é amber e compete com o aviso "por aprovar".
- IBAN match OK: retorna banner **verde silencioso**. **Issue**: ocupa espaço visual sem entregar valor (zero informação nova pro user). Deveria ser inline dot/check, não card.
- Sem QR-AT: chip `badge-neutral` "Sem QR-AT" — minimalista demais, parece broken.

### 6.3 Dirty state

- **Não há indicador de mudanças não salvas.** Usuário edita fornecedor → clica "Voltar" → perde tudo sem aviso. (Browser pode avisar em alguns casos, mas não confiável.)
- `draft` é local; após `setDraft(null)` no Save bem-sucedido, **mas não há listener pro beforeunload**.

### 6.4 Mobile (col-span-1 fallback)

- Em mobile, vira stack vertical. Provavelmente o `FieldPanel` fica abaixo do `DocumentViewer` (que tem `min-h-[420px]` + iframe), mas não testei. O grid `xl:grid-cols-12` colapsa pra `grid-cols-1` — ok.
- Tabela de linhas com `overflow-x-auto -mx-2 px-2` — scroll horizontal aceitável mas cramped em mobile.

### 6.5 A11y

- Pontos fortes: `role="alert"` no IBAN mismatch, `aria-busy` nos botões, `aria-expanded` no QR-AT toggle, focus-visible global.
- Pontos fracos: nenhuma `<legend>` tem `sr-only` ou equivalente — visíveis (correto), mas fieldset `disabled={approved}` desabilita TODOS os campos ao aprobar (bom).
- Contraste: declarado WCAG AA no header do globals.css, mas **não auditado** — só declarado. Risco real, especialmente no `text-subtle` (`#64748b` sobre `#070b14`).

### 6.6 Navegação contextual

- Sem breadcrumb (a URL é `/documents/[id]` mas o PageHeader não mostra caminho).
- Sem botão "Próximo documento" / "Anterior" — útil para revisão em batch.
- Sem atalho de teclado visível (k/Cmd+S, Cmd+Enter para aprovar, etc.) apesar de haver `kbd` utility.

---

## 7. 3 screenshots conceituais (ASCII)

### 7.1 Estado padrão — documento EM_REVISAO com QR-AT válido

```
╔══════════════════════════════════════════════════════════════════════════╗
║  FT 2026/1234                                              [Voltar]   ║
║  EDP Comercial — Comercialização de Energia, S.A. · 500000001            ║
║                                                  [ EM REVISÃO ]          ║
╠══════════════════════════════════════════════════════════════════════════╣
║ ┌─── LEFT (sticky) ────────────┐ ┌─── RIGHT (scroll) ─────────────────┐ ║
║ │ ┌──────────────────────────┐ │ │ Campos extraídos  [Refeições — 100%]│ ║
║ │ │ 📄 FT-2026-abcd.pdf [↗]⬇│ │ │              [Re-extrair][Aprovar]  │ ║
║ │ ├──────────────────────────┤ │ │              [      Guardar     ]   │ ║
║ │ │                          │ │ │                                    │ ║
║ │ │      [PDF iframe]        │ │ │ ┌── IDENTIDADE ──────────────────┐ │ ║
║ │ │      (render do PDF)     │ │ │ │ Fornecedor [EDP Comercial..] 94%││ ║
║ │ │                          │ │ │ │ NIF       [500000001]      98%  ││ ║
║ │ │                          │ │ │ │ Nº doc    [FT 2026/1234]   92%  ││ ║
║ │ └──────────────────────────┘ │ │ │ ATCUD     [ABC1234-56789] 96%  ││ ║
║ │                              │ │ └────────────────────────────────┘ │ ║
║ │ ┌── AUTENTICAÇÃO AT ────────┐ │ │ ┌── DATAS E IBAN ───────────────┐ │ ║
║ │ │ ▣ QR-AT detectável  [válido]│ │ │ │ Data doc. [2026-08-15]   91% ││ ║
║ │ │   NIF 500000001 · FT...    │ │ │ │ Vencimento[2026-09-14]   86% ││ ║
║ │ │                            │ │ │ │ IBAN      [PT50 0035 0651..] 55%│
║ │ └────────────────────────────┘ │ │ └────────────────────────────────┘ │ ║
║ │                              │ │ │ ┌── CATEGORIA ────────────────┐  │ ║
║ │ ┌── VERIFICAÇÃO IBAN ──────┐ │ │ │ [Refeições — dedução 100% ▾]│  │ ║
║ │ │ ✓ IBAN confere com histórico│ │ │ └────────────────────────────────┘ │ ║
║ │ │   PT50 0035 0651 0000... │ │ │ ┌── MONTANTES ─────────────────┐ │ ║
║ │ └────────────────────────────┘ │ │ │ Base [128.06]  IVA[23.39]   ││ ║
║ │                              │ │ │ │ Total [151.45] EUR            ││ ║
║ │                              │ │ │ │ ──────────────────────────────││ ║
║ │                              │ │ │ │ Soma linhas: 128.06           ││ ║
║ │                              │ │ │ │ Base+IVA:     151.45           ││ ║
║ │                              │ │ │ │ Δ Total−Linhas:  0.00 ✓        ││ ║
║ │                              │ │ │ └────────────────────────────────┘ │ ║
║ │                              │ │ │ ┌── LINHAS (4) ───────────────┐  │ ║
║ │                              │ │ │ │ Descrição  Qtd  P.un.  IVA  Tot│ │ ║
║ │                              │ │ │ │ Energia..  420  0,18  23% 75,60││ ║
║ │                              │ │ │ │ Energia..  280  0,12  23% 33,60││ ║
║ │                              │ │ │ │ Tarifa..   1   8,95  23%  8,95││ ║
║ │                              │ │ │ │ Imposto..  1   9,91  23%  9,91││ ║
║ │                              │ │ │ │ TOTAIS:                 128,06││ ║
║ │                              │ │ │ └────────────────────────────────┘ │ ║
║ │                              │ │ │ ┌── CONTABILIZAÇÃO ─────────────┐ │ ║
║ │                              │ │ │ │ Débito [62 · FSE]  Crédito [22]││ ║
║ │                              │ │ │ └────────────────────────────────┘ │ ║
║ │                              │ │ │ ─ Enviar para TOConline ─  [Enviar]│ ║
║ │                              │ │ │ ⚠ Documento por aprovar. ...        │ ║
║ └──────────────────────────────┘ └────────────────────────────────────┘ ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### 7.2 Estado de alerta — IBAN mismatch

```
║ ┌── VERIFICAÇÃO IBAN ──────────────────────────────────────┐
║ │ ⚠ IBAN NÃO CONFERE COM O HISTÓRICO DO FORNECEDOR          │
║ │                                                            │
║ │   Neste documento:    PT50 0035 0651 9999 9999 0712         │
║ │   Histórico conhecido: PT50 0035 0651 0000 0000 0712 (8×   │
║ │                       desde 2025-11-04) · ...0231 (3×)       │
║ │                                                            │
║ │ ⚠ Possível fraude ou troca de IBAN — confirme antes.      │
║ └────────────────────────────────────────────────────────────┘
```

### 7.3 Estado pós-aprovação (form travado)

```
║ Campos extraídos  [Refeições — 100%] [✓ Aprovado]
║                                  [Re-extrair]               ← disabled? check
║                                  [     Guardar     ]        ← disabled
║ ─────────────────────────────────────────────────────────────
║ IDENTIDADE DO DOCUMENTO                          ← fieldset disabled
║   Fornecedor  [EDP Comercial — ...]              ← input greyed
║   NIF         [500000001]
║   ...
║ LINHAS DO DOCUMENTO (4)            [Adicionar linha]  ← hidden (sem canEdit)
║   Descrição  Qtd  P.un.  IVA  Total       (read-only)
║ ...
║ CONTABILIZAÇÃO                              ← fieldset disabled
║ ─ Enviar para TOConline ─                [Enviar]  ← enabled agora
║ ⚠ Documento por aprovar. ...                        ← HIDDEN (porque approved)
```

---

## 8. Inventário rápido (referência para o designer)

### 8.1 Componentes a serem possivelmente redesenhados

| Componente | Linhas | Risco | DFII candidate |
|---|---|---|---|
| `page.tsx` (orquestrador) | 388 | Baixo — lógica, não visual | — |
| `field-panel.tsx` | 862 | **Alto** — denso, repetitivo, 8 fieldsets | Sim |
| `document-viewer.tsx` | 208 | Médio — toolbar genérica | Talvez |
| `qr-badge.tsx` | 179 | Médio — estado vazio fraco, dl em 2-col sem hierarquia | Sim |
| `fraud-warning.tsx` | 129 | Médio — 3 variantes, copy bom, visual sem personalidade | Talvez |

### 8.2 Tokens disponíveis que ainda não estão sendo explorados

- `--glow`, `--glow-violet`, `--glow-emerald` — definidos, só usados em `.card-hover` (que não é usado nesta página).
- `--brand-gradient`, `--brand-gradient-soft` — só em `.btn-primary` e `.nav-item-active`.
- `@keyframes orbDrift`, `pulseGlow`, `fadeInScale`, `slideInRight` — definidos, **nenhum** aplicado nesta página (só `fadeInUp` via `.animate-in`).
- `.kbd` utility — definida, **não usada** aqui. Oportunidade para atalhos de teclado visíveis.
- `.glass` / `.glass-card` — definidos, **não usados** aqui. PDF viewer poderia usar.

### 8.3 Tailwind disponível

- `colors.bg`, `colors.accent`, etc. — mapeados.
- `boxShadow.glow`, `glow-violet`, `glow-emerald`.
- `fontFamily.mono` (JetBrains Mono).
- `borderRadius.DEFAULT` = `--radius` (1rem).

### 8.4 Classes utilitárias-chave já em uso

- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`
- `.input`, `.input-xs` (não definida mas usada — verificar), `.input-sm`, `.input-lg`
- `.card`, `.glass-card`
- `.badge` + 6 variantes
- `.field-group`, `.label`, `.field-help`, `.field-error`
- `.animate-in`, `.animate-pop`, `.animate-slide-in`
- `.tabular-nums`
- `:focus-visible` global

---

## 9. Recomendações resumidas (para o designer priorizar)

### Quick wins (1-2 dias)

1. **A11y real** — auditoria de contraste no estado `text-subtle` sobre `bg-card` (declarado AA mas não auditado).
2. **Dirty-state guard** — listener `beforeunload` quando `draft !== null`. Previne perda de dados.
3. **Confirmação em DELETE linha** — `<Confirm>` ou modal nativo. Risco real.
4. **Skeleton estruturado** — substituir spinner único por placeholders nos 4 cards principais.
5. **Empty IBAN match** — substituir card verde silencioso por chip inline (`✓ confere`) ou nada.
6. **Empty QR-AT** — copy mais informativo ("Documento não traz QR-AT — verifique manualmente").

### Mid-effort (1 sprint)

7. **Hierarquia do header** — botão "Aprovar" como `btn-primary` quando documento está revisado; "Guardar" como secondary (inverter pesos).
8. **Atalhos de teclado** — `⌘S` (save), `⌘↵` (approve), `?` (help). Mostrar `.kbd` no header.
9. **Status hero** — banner grande de status no topo (não badge miúdo). Especialmente útil para REJEITADO.
10. **Mobile audit** — testar em 375px e 768px. Provavelmente `FieldPanel` precisa de accordion por fieldset.

### High-impact (UI overhaul real)

11. **Diferenciação tipográfica** — sair de Inter; considerar **GT America Mono / Söhne / Suisse Int'l** (display) + **Söhne / Inter Tight** (body). Ou um serif de contraste (e.g. **Editorial New** + **Inter Tight**) para alinhar com "fiscal/editorial" tone.
12. **Anchor memorável** — um elemento que define DocFlow. Proposta: número de protocolo **monoespaçado e oversized** no header (e.g. "FT 2026/1234" em 48px, JetBrains Mono, brand-gradient text).
13. **Palette decision** — escolher uma dominante (e.g. **violet-700 base + cyan accent + warm cream**) ou ficar no tricolor atual, mas COMITTEE. Semantizar: `success` nunca na mesma hue que `accent-2`.
14. **Spatial rhythm** — fieldset → group de 3 com header compartilhado (e.g. "Identidade", "Datas", "Validação" como 3 cards horizontais em desktop, stack em mobile). Reduzir 9 cards pra 5 grupos.
15. **Reconciliation visual** — o footer "Soma linhas / Base+IVA / Δ total" é informação crítica de auditoria. Merece visualização mais forte (e.g. mini-bar chart ou diagrama de Sankey micro, não 3 números em linha).

---

## 10. O que o designer precisa saber (TL;DR do briefing)

- **É uma página de auditoria fiscal PT** — confiança OCR é central, IBAN-fraud é crítico, QR-AT é decoração técnica importante.
- **Já tem tokens fortes** (dark/light, brand-gradient, glow, motion) — não precisa inventar paleta do zero.
- **Já tem 8 cards empilhados** — o problema é saturação, não falta de seções.
- **Zero memorabilidade atual** — oportunidade clara de criar um anchor (hero do nº doc, ou reconciliation visual).
- **Falta confirmar 1 ação destrutiva** (delete linha) — risco real, fácil de corrigir.
- **Falta dirty-state guard** — risco de perda de dados do utilizador, fácil de corrigir.
- **Mobile é guess** — precisa teste.
- **DFII** ainda não foi aplicado (próxima fase).

---

## 11. Ficheiros lidos (referência para revisão)

```
apps/web/app/(dashboard)/documents/[id]/page.tsx                          388 LOC
apps/web/app/(dashboard)/documents/[id]/_components/field-panel.tsx       862 LOC
apps/web/app/(dashboard)/documents/[id]/_components/document-viewer.tsx   208 LOC
apps/web/app/(dashboard)/documents/[id]/_components/qr-badge.tsx          179 LOC
apps/web/app/(dashboard)/documents/[id]/_components/fraud-warning.tsx     129 LOC
apps/web/app/(dashboard)/documents/[id]/_lib/use-document-detail.ts       412 LOC
apps/web/app/globals.css                                                  570 LOC
apps/web/tailwind.config.ts                                                80 LOC
```

**Nenhuma edição foi feita.** Relatório pronto para o designer atacar.
